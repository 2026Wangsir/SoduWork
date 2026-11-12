# Public source build; no private registry or organization credentials required.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${NODE_IMAGE} AS admin-build
WORKDIR /build/hub-frontend
COPY hub-frontend/package.json hub-frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY hub-frontend/src ./src
COPY hub-frontend/public ./public
COPY hub-frontend/index.html hub-frontend/vite.config.js ./
COPY client/core/connector-brand.js /build/client/core/connector-brand.js
COPY client/components/panels/connector-config.js /build/client/components/panels/connector-config.js
COPY client/components/client-auth/legal-html.js /build/client/components/client-auth/legal-html.js
COPY client/components/client-auth/legal-html.css /build/client/components/client-auth/legal-html.css
COPY client/assets/connector-brands /build/client/assets/connector-brands
RUN npm run build

FROM ${NODE_IMAGE} AS node-runtime
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# Official PostgreSQL client matches the Compose database (including backups).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       postgresql-client-16 git openssh-client chromium fonts-noto-cjk \
    && apt-get purge -y --auto-remove curl gnupg && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /srv/app/hub-backend
COPY hub-backend/requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY hub-backend/app ./app
COPY hub-backend/migrations ./migrations
COPY hub-backend/jiyong-alembic.ini ./jiyong-alembic.ini
COPY hub-backend/jiyong-migrations ./jiyong-migrations
COPY hub-backend/installers ./installers
COPY hub-backend/plugins ./plugins
COPY hub-backend/alembic.ini hub-backend/db_admin.py hub-backend/full_backup.py ./
COPY hub-backend/runner_main.py hub-backend/requirements-runner.txt hub-backend/pack_plugin.py ./
COPY hub-backend/client-update-trust.json ./
COPY --from=admin-build /build/hub-frontend/dist /srv/app/hub-frontend/dist
COPY skills /srv/app/skills
COPY third-party /srv/app/third-party
COPY LICENSE /srv/app/LICENSE
COPY --from=node-runtime /usr/local/LICENSE /usr/local/LICENSE.nodejs
RUN groupadd --gid 10001 soduwork && useradd --uid 10001 --gid 10001 --create-home soduwork \
    && mkdir -p uploads downloads client-releases workspaces releases /srv/runtime /srv/app/repos \
    && chown -R 10001:10001 /srv/app /srv/runtime
ENV SODUWORK_SHOT_BROWSER=/usr/bin/chromium SODUWORK_DATA_ROOT=/srv/runtime
USER 10001:10001
EXPOSE 8989
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8989"]
