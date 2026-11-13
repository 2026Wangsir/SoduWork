# Public source build; no private registry or organization credentials required.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
# Optional reviewed dependency image; the default builds everything from source.
# docker build --build-arg HUB_BASE_IMAGE=deps -f ops/self-host/Dockerfile .
ARG HUB_BASE_IMAGE=deps
FROM ${NODE_IMAGE} AS admin-build
WORKDIR /build/hub-frontend
COPY hub-frontend/package.json hub-frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY hub-frontend/src ./src
COPY hub-frontend/public ./public
COPY hub-frontend/index.html hub-frontend/vite.config.js ./
COPY client/core/connector-brand.js /build/client/core/connector-brand.js
COPY client/components/panels/connector-config.js /build/client/components/panels/connector-config.js
COPY client/components/client-auth/legal-html.js client/components/client-auth/legal-html.css /build/client/components/client-auth/
COPY client/assets/connector-brands /build/client/assets/connector-brands
RUN npm run build

FROM ${NODE_IMAGE} AS node-runtime
FROM ${PYTHON_IMAGE} AS deps
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
# Official PostgreSQL client matches the Compose database (including backups).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends git openssh-client \
       chromium fonts-noto-cjk postgresql-client-16 \
    && apt-get purge -y --auto-remove curl gnupg && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g --no-audit --no-fund \
       @earendil-works/pi-coding-agent@0.83.0 \
       @openai/codex@0.147.0
COPY --from=node-runtime /usr/local/LICENSE /usr/local/LICENSE.nodejs
WORKDIR /srv/app/hub-backend
COPY hub-backend/requirements.txt ./requirements.txt
RUN python -m pip install -r requirements.txt

FROM ${HUB_BASE_IMAGE} AS runtime
# Reconcile dependencies even when reusing an older reviewed base image.
USER root
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv/app/hub-backend
COPY hub-backend/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY hub-backend/app ./app
COPY hub-backend/migrations ./migrations
COPY hub-backend/jiyong-alembic.ini ./jiyong-alembic.ini
COPY hub-backend/jiyong-migrations ./jiyong-migrations
COPY hub-backend/installers ./installers
COPY hub-backend/plugins ./plugins
COPY hub-backend/alembic.ini ./alembic.ini
COPY hub-backend/db_admin.py ./db_admin.py
COPY hub-backend/full_backup.py ./full_backup.py
COPY hub-backend/runner_main.py ./runner_main.py
COPY hub-backend/pack_plugin.py ./pack_plugin.py
COPY hub-backend/requirements-runner.txt ./
COPY hub-backend/import_client_release.py ./import_client_release.py
COPY hub-backend/ops_publish_builtin_plugins.py ./ops_publish_builtin_plugins.py
COPY hub-backend/client-update-trust.json ./client-update-trust.json
COPY --from=admin-build /build/hub-frontend/dist /srv/app/hub-frontend/dist
COPY skills /srv/app/skills
COPY third-party /srv/app/third-party
COPY LICENSE /srv/app/LICENSE
RUN groupadd --gid 10001 soduwork && useradd --uid 10001 --gid 10001 --create-home soduwork \
    && mkdir -p uploads downloads client-releases workspaces releases /srv/runtime /srv/app/repos \
    && chown -R 10001:10001 /srv/app /srv/runtime
ENV SODUWORK_SHOT_BROWSER=/usr/bin/chromium SODUWORK_DATA_ROOT=/srv/runtime
USER 10001:10001

# Identity is the final layer so release metadata does not invalidate dependencies.
ARG SODUWORK_VERSION=dev
ARG SODUWORK_HUB_VERSION=dev
ARG SODUWORK_RELEASE_TAG=""
ENV SODUWORK_DEPLOY_COMMIT="${SODUWORK_VERSION}" \
    SODUWORK_HUB_VERSION="${SODUWORK_HUB_VERSION}" \
    SODUWORK_RELEASE_TAG="${SODUWORK_RELEASE_TAG}" \
    SODUWORK_DEPLOY_AT=""
LABEL org.opencontainers.image.title="SoduWork Hub" \
      org.opencontainers.image.version="${SODUWORK_HUB_VERSION}" \
      org.opencontainers.image.revision="${SODUWORK_VERSION}"
EXPOSE 8989
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8989"]
