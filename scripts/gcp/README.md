# Deploy Tracer to Google Cloud

One always-on container runs on one Compute Engine VM. Keys live in Secret Manager.

## What runs where

```
Your laptop                         Google Cloud project
-----------                         --------------------
deploy.sh  --- Cloud Build -------> Artifact Registry (image)
           --- gcloud ------------> Secret Manager (keys)
                                    Compute Engine e2-micro, Container-Optimized OS
browser <-- localhost:3580          |  docker container "tracer" (host network)
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

Run `scripts/gcp/deploy.sh` again. The script builds a new image, updates the VM metadata, and restarts the VM. The stop is graceful, so the database closes cleanly.
The build log does not show in the terminal. If the build fails, open the log link that the script prints.
The base image in the `Dockerfile` is pinned by digest. Update the digest from time to time to get operating system patches.

## Chat with it

1. Open a tunnel and keep it open:

   ```
   scripts/gcp/deploy.sh open
   ```

2. In a browser, open `http://localhost:3580`. You get the full Tracer app: chat, monitors, alerts and settings. Everything runs on the VM.
3. Or ask from the terminal, through the same tunnel:

   ```
   TRACER_PORT=3580 tracer-sh analyze "Why did checkout errors spike after 14:00 UTC?"
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
- The server process holds the keys in memory. It removes them from its environment after start, so its child processes do not get them.
- The server listens on 127.0.0.1. It accepts connections only from inside the VM, so no firewall rule can expose port 3579.
- SSH is the only way in. The script allows SSH from the IAP address range and denies it from all other addresses, for this VM only. Other VMs on the network keep their rules.
- The VM uses OS Login. Your Google account and its IAM roles decide who can SSH. SSH keys in the project metadata do not work on this VM.
- The container runs as a non-root user with a read-only file system and no Linux capabilities.
- The VM runs the image by its digest. The image build runs as its own service account. That account can only read the build source, write the image and write logs.
- These people can read the keys:
  - project owners, and anyone you give Secret Manager access;
  - anyone who can SSH into the VM, because root on the VM can read the running process;
  - anyone who can open the tunnel, because the app's settings can send a stored key to a host of their choice;
  - project editors and Compute admins, because they can change the VM metadata, which sets the image that the VM runs;
  - anyone who can act as the service account `tracer-worker`;
  - anyone who can change the image build or write to the `tracer` image repository, from the next deploy.
- Use a separate project, or give only yourself these roles, if other people work in the project.
- While the tunnel is open, each program on your laptop can use `localhost:3580`.

## How keys reach the server

1. At start, the container reads `TRACER_SECRETS` (for example `TRACER_DB_KEY=tracer-db-key,TRACER_ANTHROPIC_API_KEY=tracer-anthropic-api-key`) from the VM metadata.
2. It fetches each secret from Secret Manager with the VM service account. If one fetch fails, the container stops before it opens the database.
3. The server writes the connector keys into its encrypted database.

Variables: `TRACER_DB_KEY`, `TRACER_GOOGLE_API_KEY`, `TRACER_ANTHROPIC_API_KEY`, `TRACER_NEW_RELIC_API_KEY`, `TRACER_NEW_RELIC_ACCOUNT_ID`, `TRACER_POSTHOG_API_KEY`, `TRACER_POSTHOG_PROJECT_ID`, `TRACER_POSTHOG_HOST`, `TRACER_JIRA_DOMAIN`, `TRACER_JIRA_EMAIL`, `TRACER_JIRA_API_TOKEN`, `TRACER_SLACK_WEBHOOK_URL`, `TRACER_CHAT_MODEL`.
The same variables work without Secret Manager, for example with `docker run -e`. In that case the values stay visible in `docker inspect`.
`TRACER_SECRETS` accepts only names that start with `TRACER_`, and it must include `TRACER_DB_KEY`.

Secret Manager is the source of truth for keys. A key that you change in the UI goes back to the Secret Manager value at the next restart. Change keys with `deploy.sh keys`.
To remove a key, delete its secret (`gcloud secrets delete tracer-jira-api-token`), run `deploy.sh keys`, then remove the key in the app's settings. The database keeps a key until you remove it there.
`TRACER_CHAT_MODEL` sets only the first model. A model that you pick in the UI stays.

## Limits

- The Google Cloud data source and Vertex AI do not work on the VM yet.
- "Update now" in the app does not apply in a container. Redeploy instead.
- The data directory is on the VM boot disk. Deleting the VM deletes the data.
