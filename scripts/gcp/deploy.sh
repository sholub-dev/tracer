#!/usr/bin/env bash
# Deploy Tracer to one Compute Engine VM (see scripts/gcp/README.md).
set -euo pipefail

cd "$(dirname "$0")/../.."

PROJECT=
ZONE=us-west1-b
NAME=tracer
NETWORK=default
PORT=3580
SA_NAME=tracer-worker
BUILD_SA_NAME=tracer-build
REPO=tracer

# env name | secret id | prompt | hidden (empty prompt = set automatically)
KEYS=(
  "TRACER_DB_KEY|tracer-db-key||"
  "TRACER_CHAT_MODEL|tracer-chat-model||"
  "TRACER_GOOGLE_API_KEY|tracer-google-api-key|Google AI (Gemini) API key|yes"
  "TRACER_ANTHROPIC_API_KEY|tracer-anthropic-api-key|Anthropic API key|yes"
  "TRACER_NEW_RELIC_API_KEY|tracer-newrelic-api-key|New Relic API key|yes"
  "TRACER_NEW_RELIC_ACCOUNT_ID|tracer-newrelic-account-id|New Relic account id|no"
  "TRACER_POSTHOG_API_KEY|tracer-posthog-api-key|PostHog API key|yes"
  "TRACER_POSTHOG_PROJECT_ID|tracer-posthog-project-id|PostHog project id|no"
  "TRACER_POSTHOG_HOST|tracer-posthog-host|PostHog host|no"
  "TRACER_JIRA_DOMAIN|tracer-jira-domain|Jira domain|no"
  "TRACER_JIRA_EMAIL|tracer-jira-email|Jira email|no"
  "TRACER_JIRA_API_TOKEN|tracer-jira-api-token|Jira API token|yes"
  "TRACER_SLACK_WEBHOOK_URL|tracer-slack-webhook-url|Slack webhook URL|yes"
)

usage() {
  cat <<USAGE
Usage: scripts/gcp/deploy.sh [command] [options]

Commands:
  deploy   Set up Google Cloud, ask for keys, build the image, create or update the VM (default).
  keys     Ask for keys, then restart the container.
  open     Open an SSH tunnel to the UI.
  logs     Print the last 200 log lines.

Options:
  --project ID     Google Cloud project (default: the gcloud project)
  --zone ZONE      VM zone (default: us-west1-b)
  --name NAME      VM name (default: tracer)
  --network NAME   VPC network (default: default)
  --port PORT      Local port for "open" (default: 3580)
  -h, --help       Show this help
USAGE
}

die() { echo "Error: $*" >&2; exit 1; }

secret_exists() {
  local out
  out=$(gcloud secrets describe "$1" --project "$PROJECT" 2>&1) && return 0
  # Only "not found" means absent. Any other error must stop the script, or a key drops out of the list.
  [[ $out == *NOT_FOUND* ]] && return 1
  die "Cannot read secret $1: $out"
}

check_gcloud() {
  command -v gcloud >/dev/null || die "gcloud is not installed."
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)')
  [[ -n $ACCOUNT ]] || die "No active gcloud account. Run: gcloud auth login"
  [[ -n $PROJECT ]] || die "No project. Pass --project ID or run: gcloud config set project ID"
}

confirm() {
  echo "Account: $ACCOUNT"
  echo "Project: $PROJECT"
  echo "Zone:    $ZONE   VM: $NAME"
  read -rp "Make changes in this project? [y/N] " answer
  [[ $answer == [yY]* ]] || exit 1
}

enable_apis() {
  gcloud services enable compute.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com iap.googleapis.com \
    --project "$PROJECT"
}

ensure_service_accounts() {
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$SA_NAME" --display-name "Tracer VM" --project "$PROJECT"
  gcloud iam service-accounts describe "$BUILD_SA" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$BUILD_SA_NAME" --display-name "Tracer image build" --project "$PROJECT"
  local role
  for role in roles/logging.logWriter roles/monitoring.metricWriter; do
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null
  done
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$BUILD_SA" --role roles/logging.logWriter --condition=None >/dev/null
}

store_secret() { # id; value on stdin
  if secret_exists "$1"; then
    gcloud secrets versions add "$1" --data-file=- --project "$PROJECT" >/dev/null
  else
    gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
}

prompt_keys() {
  local entry env id prompt hidden state value
  echo "Press Enter to keep a value that is already set."
  for entry in "${KEYS[@]}"; do
    IFS='|' read -r env id prompt hidden <<<"$entry"
    [[ -n $prompt ]] || continue
    if secret_exists "$id"; then state=set; else state="not set"; fi
    if [[ $hidden == yes ]]; then
      read -rsp "$prompt [$state]: " value; echo
    else
      read -rp "$prompt [$state]: " value
    fi
    [[ -z $value ]] || printf '%s' "$value" | store_secret "$id"
    unset value
  done
}

ensure_db_key() {
  # A second version would make the existing database unreadable.
  local key
  if ! secret_exists tracer-db-key; then
    key=$(openssl rand -hex 32)
    [[ ${#key} -eq 64 ]] || die "openssl did not make a database key."
    printf '%s' "$key" |
      gcloud secrets create tracer-db-key --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
    unset key
  fi
  [[ -n $(gcloud secrets versions list tracer-db-key --project "$PROJECT" --filter=state=ENABLED --limit 1 --format='value(name)') ]] ||
    die "Secret tracer-db-key has no enabled version. If no database uses it, delete the secret and run again."
}

ensure_chat_model() {
  if ! secret_exists tracer-google-api-key && secret_exists tracer-anthropic-api-key &&
    ! secret_exists tracer-chat-model; then
    printf '%s' anthropic/claude-haiku-4-5-20251001 | store_secret tracer-chat-model
  fi
}

require_llm_key() {
  secret_exists tracer-google-api-key || secret_exists tracer-anthropic-api-key ||
    die "Set at least one LLM key (Google AI or Anthropic)."
}

# Writes ENV=ID pairs for existing secrets to $TMP/secrets and grants the VM access to each.
build_secrets() {
  local entry env id out=()
  for entry in "${KEYS[@]}"; do
    IFS='|' read -r env id _ <<<"$entry"
    secret_exists "$id" || continue
    gcloud secrets add-iam-policy-binding "$id" --project "$PROJECT" \
      --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
    out+=("$env=$id")
  done
  [[ ${out[0]:-} == TRACER_DB_KEY=* ]] || die "Secret tracer-db-key is missing."
  (IFS=,; printf '%s' "${out[*]}") >"$TMP/secrets"
}

setup_keys() {
  prompt_keys
  ensure_db_key
  ensure_chat_model
  require_llm_key
}

ensure_repo() {
  gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud artifacts repositories create "$REPO" --repository-format docker \
      --location "$REGION" --project "$PROJECT"
  gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
    --project "$PROJECT" --member "serviceAccount:$SA" --role roles/artifactregistry.reader >/dev/null
  gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
    --project "$PROJECT" --member "serviceAccount:$BUILD_SA" --role roles/artifactregistry.writer >/dev/null
}

build_image() {
  local version sha tag digest
  version=$(node -p "require('./package.json').version")
  sha=$(git rev-parse --short HEAD)
  [[ -z $(git status --porcelain) ]] || sha="$sha-dirty"
  tag="$version-$sha"
  IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/tracer"
  # A build account with no other rights: the build steps can reach the token of the account they run as.
  local bucket="gs://${PROJECT}_cloudbuild"
  gcloud storage buckets describe "$bucket" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud storage buckets create "$bucket" --project "$PROJECT"
  gcloud storage buckets add-iam-policy-binding "$bucket" \
    --member "serviceAccount:$BUILD_SA" --role roles/storage.objectViewer >/dev/null
  cat >"$TMP/cloudbuild.yaml" <<'YAML'
steps:
  - name: gcr.io/cloud-builders/docker
    args: [build, -t, $_IMAGE, .]
images: [$_IMAGE]
options:
  logging: CLOUD_LOGGING_ONLY
YAML
  gcloud builds submit --region "$REGION" --project "$PROJECT" --config "$TMP/cloudbuild.yaml" \
    --substitutions "_IMAGE=$IMAGE:$tag" \
    --service-account "projects/$PROJECT/serviceAccounts/$BUILD_SA" .
  # The VM runs the digest, so a later push to the tag cannot change what it runs.
  digest=$(gcloud artifacts docker images describe "$IMAGE:$tag" --project "$PROJECT" \
    --format='value(image_summary.digest)')
  [[ $digest == sha256:* ]] || die "Cannot read the image digest."
  IMAGE="$IMAGE@$digest"
}

ensure_firewall() {
  gcloud compute networks describe "$NETWORK" --project "$PROJECT" >/dev/null 2>&1 ||
    die "Network '$NETWORK' does not exist. Pass --network with an existing network."
  # SSH only from IAP. The deny rule beats wider rules on the network, such as default-allow-ssh.
  if gcloud compute firewall-rules describe tracer-allow-iap-ssh --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute firewall-rules update tracer-allow-iap-ssh --project "$PROJECT" --priority 900
  else
    gcloud compute firewall-rules create tracer-allow-iap-ssh --project "$PROJECT" \
      --network "$NETWORK" --direction INGRESS --allow tcp:22 --priority 900 \
      --source-ranges 35.235.240.0/20 --target-tags tracer
  fi
  gcloud compute firewall-rules describe tracer-deny-ssh --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud compute firewall-rules create tracer-deny-ssh --project "$PROJECT" \
      --network "$NETWORK" --direction INGRESS --action DENY --rules tcp:22 --priority 950 \
      --source-ranges 0.0.0.0/0 --target-tags tracer
}

deploy_vm() {
  # OS Login ties SSH to IAM roles; keys in the project metadata do not work on this VM.
  local meta=(--metadata "tracer-image=$IMAGE,google-logging-enabled=true,enable-oslogin=TRUE,block-project-ssh-keys=TRUE"
    --metadata-from-file "user-data=scripts/gcp/cloud-init.yaml,tracer-secrets=$TMP/secrets")
  if gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute instances add-metadata "$NAME" --zone "$ZONE" --project "$PROJECT" "${meta[@]}"
    # A stop is a graceful shutdown. The next boot re-applies cloud-init and pulls the new image.
    gcloud compute instances stop "$NAME" --zone "$ZONE" --project "$PROJECT"
    gcloud compute instances start "$NAME" --zone "$ZONE" --project "$PROJECT"
  else
    gcloud compute instances create "$NAME" --zone "$ZONE" --project "$PROJECT" \
      --machine-type e2-micro --image-family cos-stable --image-project cos-cloud \
      --boot-disk-size 10GB --boot-disk-type pd-standard \
      --service-account "$SA" --scopes cloud-platform --tags tracer \
      --network "$NETWORK" --shielded-secure-boot "${meta[@]}"
  fi
}

ssh_vm() {
  gcloud compute ssh "$NAME" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap "$@"
}

cmd_deploy() {
  check_gcloud
  confirm
  enable_apis
  ensure_service_accounts
  setup_keys
  build_secrets
  ensure_repo
  build_image
  ensure_firewall
  deploy_vm
  echo
  echo "Done. Next steps:"
  echo "  scripts/gcp/deploy.sh open"
  echo "  scripts/gcp/deploy.sh logs"
}

cmd_keys() {
  check_gcloud
  confirm
  setup_keys
  build_secrets
  gcloud compute instances add-metadata "$NAME" --zone "$ZONE" --project "$PROJECT" \
    --metadata-from-file "tracer-secrets=$TMP/secrets"
  ssh_vm --command 'sudo systemctl restart tracer'
}

cmd_open() {
  check_gcloud
  echo "Open http://localhost:$PORT (press Ctrl+C to close the tunnel)"
  ssh_vm -- -N -L "$PORT:127.0.0.1:3579"
}

cmd_logs() {
  check_gcloud
  ssh_vm --command 'sudo journalctl -u tracer -n 200 --no-pager'
}

COMMAND=deploy
while (($#)); do
  case $1 in
    deploy|keys|open|logs) COMMAND=$1 ;;
    --project|--zone|--name|--network|--port)
      [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value."
      case $1 in
        --project) PROJECT=$2 ;;
        --zone) ZONE=$2 ;;
        --name) NAME=$2 ;;
        --network) NETWORK=$2 ;;
        --port) PORT=$2 ;;
      esac
      shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
  shift
done

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}
REGION=${ZONE%-*}
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
BUILD_SA="$BUILD_SA_NAME@$PROJECT.iam.gserviceaccount.com"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case $COMMAND in
  deploy) cmd_deploy ;;
  keys) cmd_keys ;;
  open) cmd_open ;;
  logs) cmd_logs ;;
esac
