# Deploy Tracer to Google Cloud

One always-on container runs on one Compute Engine VM. Keys live in Secret Manager.

## What runs where

```
Your laptop                         Google Cloud project
-----------                         --------------------
deploy.sh  --- Cloud Build -------> Artifact Registry (image)
           --- gcloud ------------> Secret Manager (keys)
                                    Compute Engine e2-micro, Container-Optimized OS
browser <-- 127.0.0.1:3580          |  docker container "tracer" (host network)
        <-- IAP SSH tunnel -------> |  server on 127.0.0.1:3579
                                    |  /var/lib/tracer (boot disk) -> /data (encrypted DB)
```

## Prerequisites

- The `gcloud` CLI, signed in with `gcloud auth login` as a project owner.
- A Google Cloud project with billing enabled.
- `git`, `node` and `openssl` on your laptop.

## First deploy

```
scripts/gcp/deploy.sh --project my-project
```

The script prints the account and project and asks for confirmation. It then enables the APIs, creates the service account, asks for keys, builds the image, and creates the VM. Run it again at any time. Each step skips work that is already done.

Options: `--project` (default: the gcloud project), `--zone` (default `us-west1-b`), `--name` (default `tracer`), `--network` (default `default`). Run `scripts/gcp/deploy.sh --help` for the full list.

You must give at least one LLM key (Google AI or Anthropic). With only an Anthropic key, the script sets the chat model to `anthropic/claude-haiku-4-5-20251001`.

## Update keys

```
scripts/gcp/deploy.sh keys
```

Press Enter to keep a value. The script adds a new secret version and restarts the container. The database key is created once and never changes. A new database key makes the existing database unreadable.

## Update code

Commit your changes, then run `scripts/gcp/deploy.sh` again. The script builds a new image from the last commit, updates the VM metadata, and restarts the VM. The stop is graceful, so the database closes cleanly.
The build uses only committed files. Uncommitted and untracked files do not leave your laptop.
The build log does not show in the terminal. If the build fails, open the log link that the script prints.
The base image in the `Dockerfile` is pinned by digest. Update the digest from time to time to get operating system patches.

## Chat with it

1. Open a tunnel and keep it open:

   ```
   scripts/gcp/deploy.sh open
   ```

2. In a browser, open the link that the script prints. It looks like `http://127.0.0.1:3580/#t=...` and holds the session token of the VM server. You get the full Tracer app: chat, monitors, alerts and settings. Everything runs on the VM. After the first time, `http://127.0.0.1:3580` works in the same browser.
3. Or ask from the terminal, through the same tunnel. The script prints this command with the token:

   ```
   TRACER_PORT=3580 TRACER_TOKEN=... tracer-sh analyze "Why did checkout errors spike after 14:00 UTC?"
   ```

4. Press Ctrl+C in the first terminal to close the tunnel.

Use `--port PORT` for a different local port. The default 3580 does not clash with a local Tracer on 3579.
Monitors run on the VM all the time. Findings go to Slack with no tunnel open.

## Logs

```
scripts/gcp/deploy.sh logs
```

## Costs

- The e2-micro VM and 30 GB of standard disk are free in `us-west1`, `us-central1` and `us-east1`. The VM uses 10 GB.
- The external IPv4 address costs about $3.65 per month.
- Secret Manager costs about $0.06 per secret version above 6 free versions.
- Cloud Build has free build minutes.

## Security model

- Keys are stored in Secret Manager and in the encrypted database on the VM disk. They are not in the image, the git repo, the VM metadata, the build logs or your shell history.
- The server process holds the keys in memory. They are not in its environment or in the container configuration.
- The server cannot read Secret Manager. A separate start step fetches the keys and gives them to the server. A firewall rule on the VM stops the server user from getting a service account token.
- The server listens on 127.0.0.1, so no firewall rule can expose port 3579. Phone sync is off on the VM.
- Each API request needs the session token. The server creates it on first start and keeps it in `/var/lib/tracer/session-token`.
- SSH is the only way in. The script allows SSH from the IAP address range and denies it from all other addresses, for this VM only. The two rules have the highest priorities on the network. A firewall policy of your organization can still override them.
- The VM uses OS Login. Your Google account and its IAM roles decide who can SSH. SSH keys in the project metadata do not work on this VM.
- The container runs as a non-root user with a read-only file system and no Linux capabilities.
- The VM runs the image by its digest. The image build runs as its own service account. That account can read only its own source bucket, write the image, and write logs.
- These people can read the keys:
  - project owners, and anyone you give Secret Manager access;
  - anyone who can SSH into the VM, because root on the VM can read the running process;
  - anyone who can open the tunnel and read the session token, because the app's settings can send a stored key to a host of their choice;
  - project editors and Compute admins, because they can change the VM metadata, which sets the image that the VM runs. This includes workloads that run as the default Compute service account, if that account is an editor;
  - anyone who can act as the service account `tracer-worker`;
  - anyone who can change the image build or write to the `tracer` image repository, from the next deploy.
- Use a separate project, or give only yourself these roles, if other people work in the project.
- While the tunnel is open, other programs on your laptop can connect to `127.0.0.1:3580`. They cannot call the API without the session token.

## How keys reach the server

1. At start, the VM reads the list of secret names (for example `TRACER_DB_KEY=tracer-db-key,TRACER_ANTHROPIC_API_KEY=tracer-anthropic-api-key`) from its metadata.
2. A short-lived container fetches each secret from Secret Manager with the VM service account. If one fetch fails, the server does not start.
3. The server container receives the values on its standard input, never in its configuration.
4. The server writes the connector keys into its encrypted database and removes them from its environment.

Variables: `TRACER_DB_KEY`, `TRACER_GOOGLE_API_KEY`, `TRACER_ANTHROPIC_API_KEY`, `TRACER_NEW_RELIC_API_KEY`, `TRACER_NEW_RELIC_ACCOUNT_ID`, `TRACER_POSTHOG_API_KEY`, `TRACER_POSTHOG_PROJECT_ID`, `TRACER_POSTHOG_HOST`, `TRACER_JIRA_DOMAIN`, `TRACER_JIRA_EMAIL`, `TRACER_JIRA_API_TOKEN`, `TRACER_SLACK_WEBHOOK_URL`, `TRACER_CHAT_MODEL`.
The same variables work without Secret Manager, for example with `docker run -e`. In that case the values stay visible in `docker inspect`.
Outside this VM setup, a container can also fetch the secrets itself: set `TRACER_SECRETS` to the list of names. The list accepts only the variables above, and it must include `TRACER_DB_KEY`.

Secret Manager is the source of truth for keys. A key that you change in the UI goes back to the Secret Manager value at the next restart. Change keys with `deploy.sh keys`.
To remove a key, delete its secret (`gcloud secrets delete tracer-jira-api-token`), run `deploy.sh keys`, then remove the key in the app's settings. The database keeps a key until you remove it there.
`TRACER_CHAT_MODEL` sets only the first model. A model that you pick in the UI stays.

## Limits

- The Google Cloud data source and Vertex AI do not work on the VM yet.
- Phone sync does not work with the VM.
- The VM does not check for new versions, and "Update now" in the app does not apply in a container. Redeploy instead.
- The data directory is on the VM boot disk. Deleting the VM deletes the data.
