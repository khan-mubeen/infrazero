def build_user_data(region_slug: str) -> str:
    return f"""#!/bin/bash
set -e

REGION="{region_slug}"

apt-get update -y
apt-get install -y python3 python3-venv git

mkdir -p /opt/infrazero
cd /opt/infrazero

# clone repo if not exists
if [ ! -d "infrazero" ]; then
  git clone https://github.com/khan-mubeen/infrazero.git
fi

cd infrazero/model-service

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# export region for the service
export REGION="$REGION"

# run model-service in background on port 8000
nohup .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 > /var/log/infrazero-model.log 2>&1 &
"""
