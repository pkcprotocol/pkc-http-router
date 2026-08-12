#!/usr/bin/env bash

# deploy to a server with docker compose

# go to current folder
cd "$(dirname "$0")"
cd ..

# add env vars
if [ -f .deploy-env ]; then
  export $(echo $(cat .deploy-env | sed 's/#.*//g'| xargs) | envsubst)
fi

# check creds
if [ -z "${DEPLOY_HOST+xxx}" ]; then echo "DEPLOY_HOST not set" && exit; fi
if [ -z "${DEPLOY_USER+xxx}" ]; then echo "DEPLOY_USER not set" && exit; fi
if [ -z "${DEPLOY_PASSWORD+xxx}" ]; then echo "DEPLOY_PASSWORD not set" && exit; fi

# the compose profile to start, "https" also brings up nginx + certbot
DEPLOY_PROFILE="${DEPLOY_PROFILE:-}"

# clone or update the checkout
SCRIPT="
set -e
cd /home
if [ ! -d pkc-http-router/.git ]; then
  git clone https://github.com/pkcprotocol/pkc-http-router.git
fi
cd pkc-http-router
git reset HEAD --hard
git pull
"

# execute script over ssh
echo "$SCRIPT" | sshpass -p "$DEPLOY_PASSWORD" ssh "$DEPLOY_USER"@"$DEPLOY_HOST" bash

# copy files
FILE_NAMES=(
  .env
)

# copy files
for FILE_NAME in ${FILE_NAMES[@]}; do
  sshpass -p "$DEPLOY_PASSWORD" scp $FILE_NAME "$DEPLOY_USER"@"$DEPLOY_HOST":/home/pkc-http-router
done

# --pull always picks up the image ci published for the latest release, the image is
# never built on the server
SCRIPT="
set -e
cd /home/pkc-http-router
docker compose ${DEPLOY_PROFILE:+--profile $DEPLOY_PROFILE} up -d --pull always
docker compose ps
"

echo "$SCRIPT" | sshpass -p "$DEPLOY_PASSWORD" ssh "$DEPLOY_USER"@"$DEPLOY_HOST" bash
