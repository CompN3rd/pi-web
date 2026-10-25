# Prebuilt container images

Run PI WEB from a prebuilt image using Docker Compose or a compatible container-management UI. The deployment runs separate web and session-daemon services with persistent state and project folders. Your container manager owns updates and restarts.

## Images and release tracking

This fork publishes **`ghcr.io/compn3rd/pi-web:<npm-version>`** and **`ghcr.io/compn3rd/pi-web:latest`**. These names become available after the first successful publication. This is fork-maintained container packaging, not an upstream-published image.

The workflow checks upstream `@jmfederico/pi-web` npm `latest` every six hours. It builds the published npm package, not application source from this checkout, and does not publish npm packages or require a GitHub Release. Only upstream's current npm `latest` version updates the image's `latest` tag. Exact version tags are recommended for predictable deployments; use an image digest when you need immutable selection.

The initial image platform is **linux/amd64** (Intel/AMD 64-bit). ARM images are not currently published.

## Start with Compose

Requirements: a Docker host with the Compose plugin, or a container manager supporting Compose dependency conditions and healthchecks. No Node.js, npm or image build is required on the host.

1. Copy [the prebuilt-image Compose example](../docker/compose.image.yml) into a new deployment directory as `compose.yml`.
2. Create `data` and `projects` directories beside it. The default bind mounts are `./data:/data` and `./projects:/projects`. Use absolute host paths instead when your container manager requires them.
3. Give UID/GID **1000:1000** read/write access to the projects folder and any existing project files. Use your host's ownership, group or ACL controls; do not grant access to unrelated folders. A short-lived initialization service prepares PI WEB's state directories. It does not recursively change existing files, so restored state may need an explicit permissions adjustment.
4. Select a published image tag in the shared `x-image` value, or set `PI_WEB_IMAGE` in the deployment's `.env` file. The example defaults to `ghcr.io/compn3rd/pi-web:latest`.
5. Validate, pull and start the application:

   ```sh
   docker compose config --quiet
   docker compose pull
   docker compose up -d --wait
   ```

6. Open <http://127.0.0.1:8504>. Add a project using its container-visible path, such as `/projects/my-repository`.

A Compose UI can perform the equivalent validation, image-pull and application-creation steps. If it rejects dependency conditions, stop and inspect the error rather than removing service-readiness ordering. Compatibility with individual container-management products has not been verified.

### Paths and remote access

Optional `.env` settings:

```dotenv
PI_WEB_IMAGE=ghcr.io/compn3rd/pi-web:latest
PI_WEB_DATA_DIR=./data
PI_WEB_PROJECTS_DIR=./projects
PI_WEB_BIND_ADDR=127.0.0.1
PI_WEB_PORT=8504
```

Paths are resolved by Compose relative to the deployment configuration. The default web binding accepts connections only from the host. For access from another machine, bind to a trusted private host address, or keep localhost binding and use an SSH tunnel or authenticated reverse proxy. This recipe configures neither authentication nor TLS. Do not expose the service directly to the public internet.

To register this runtime with an existing PI WEB gateway, open **Actions → Add Machine** and enter its reachable base URL, such as `http://<private-host-address>:8504`. The gateway server must be able to reach it. Configure provider credentials on the selected runtime; the gateway does not copy credentials from its own installation. See the [machine federation guide](https://pi-web.dev/machines).

## Tooling, persistence and host access

The image reuses the existing [upstream Dockerfile](../docker/Dockerfile): Ubuntu 26.04, image-owned Node.js, Pi Coding Agent, mise, GitHub CLI, native build tools and browser system libraries. Browser binaries require a separate installation.

The application services run as UID/GID 1000:1000 with Linux capabilities dropped and privilege escalation disabled. Both services use the image-owned Node executable even when mise selects another Node version for project commands or terminals.

The image also contains Docker CLI and host-management helpers. The Compose example disables `hostexec`, mounts no Docker socket, and uses no privileged containers or host namespaces. Installed tools alone do not grant host control. Commands execute in the containers, but can modify mounted projects, use supplied credentials and access the network. This is a trusted-user runtime, not a sandbox for untrusted code.

Project files under `/projects` and PI WEB state, credentials and session history under `/data` survive recreation. Mise user tools under `/data` also persist. OS packages and changes elsewhere in the container are ephemeral. Review project `mise.toml` files before using `mise trust` and `mise install`.

Back up both host folders with sessions stopped for a consistent state backup.

## Update or roll back

Wait for active sessions to finish and back up persistent data. Select the desired published image tag, then pull and recreate the application:

```sh
docker compose pull
docker compose up -d --wait
```

When the image changes, Compose recreates the affected services. In a container-management UI, explicitly pull the image and recreate the containers; merely restarting an existing container does not update its image.

Recreating `sessiond` interrupts active agent runtimes. Use your container manager for lifecycle operations, not PI WEB's built-in host-installer update/restart commands. To roll back the software, recreate with a previous image version. An older image does not undo changes to persisted state.

## Publication and validation

Enable Actions and scheduled workflows in the fork. The workflow must be on the repository's default branch for scheduled checks to run; GitHub may delay runs or disable schedules after repository inactivity. Application source on another branch can continue tracking upstream independently.

The workflow publishes to `ghcr.io/<owner>/<repository>` using GitHub Actions package-write permission. A maintainer must make the GHCR package **public** after its first publication for anonymous pulls. An existing package may also need repository access granted.

Run **Container image** manually with `version=latest` or an exact published npm version. Scheduled checks skip existing image versions. Enable `rebuild` to refresh an existing version after image changes or base-image security updates. Selecting an older npm version does not move `latest` backward. Pull-request runs build and test without publishing.

The workflow builds `docker/Dockerfile`'s `runtime` target with `PI_WEB_VERSION` set to the selected upstream npm version. The Dockerfile retains its existing Pi installation policy. No second Dockerfile or application-source build is involved; upstream npm publication is unchanged.

Before pushing, the smoke test checks both services' availability, unavailable-daemon rejection, native terminal execution, nonroot operation, disabled host execution, tooling, project writes and state persistence. It also selects persistent mise Node 24 and confirms that recreated services retain image-owned Node while development commands use the mise-selected version.
