#!/bin/bash
set -e

# Load environment variables from .env if it exists.
# Using `set -a; source` lets bash parse quoted values correctly; the older
# `export $(grep ... | xargs)` pattern silently mangles values with spaces or
# shell metacharacters and is a known footgun for credentials.
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

# Configuration - Set these in .env or as environment variables
ACR_NAME="${ACR_NAME:?Error: ACR_NAME is required. Create a .env file from .env.template}"
ACR_LOGIN_SERVER="${ACR_LOGIN_SERVER:-$ACR_NAME.azurecr.io}"
IMAGE_TAG="${1:-latest}"

echo "🔐 Logging into ACR..."
az acr login --name $ACR_NAME

echo "🏗️ Building and pushing server image..."
cd server/Sendie.Server
docker build -t $ACR_LOGIN_SERVER/sendie-server:$IMAGE_TAG .
docker push $ACR_LOGIN_SERVER/sendie-server:$IMAGE_TAG
cd ../..

echo "🏗️ Building and pushing client image..."
cd client
docker build -t $ACR_LOGIN_SERVER/sendie-client:$IMAGE_TAG .
docker push $ACR_LOGIN_SERVER/sendie-client:$IMAGE_TAG
cd ..

echo "🚀 Deploying to Kubernetes..."
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/server-pvc.yaml

# Check if secrets.yaml exists (created from template)
if [ ! -f k8s/secrets.yaml ]; then
    echo "❌ Error: k8s/secrets.yaml not found!"
    echo "   Copy k8s/secrets.yaml.template to k8s/secrets.yaml and fill in your values."
    exit 1
fi
kubectl apply -f k8s/secrets.yaml

# Substitute environment variables in deployment templates and apply
export ACR_LOGIN_SERVER IMAGE_TAG
envsubst < k8s/server-deployment.yaml | kubectl apply -f -
envsubst < k8s/client-deployment.yaml | kubectl apply -f -
kubectl apply -f k8s/ingress.yaml

echo "🔄 Restarting deployments to pull latest images..."
kubectl rollout restart deployment/sendie-server -n sendie
kubectl rollout restart deployment/sendie-client -n sendie

echo "⏳ Waiting for rollout to complete..."
kubectl rollout status deployment/sendie-server -n sendie
kubectl rollout status deployment/sendie-client -n sendie

echo "✅ Deployment complete!"
echo ""
echo "📊 Status:"
kubectl get pods -n sendie
echo ""
echo "🌐 Ingress:"
kubectl get ingress -n sendie

# ---------------------------------------------------------------------------
# Post-deploy smoke tests.
# Set SKIP_SMOKE=1 to bypass (don't, except for the very first deploy where
# you don't yet have a public URL to hit).
# ---------------------------------------------------------------------------
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
    echo "⚠️  Skipping post-deploy smoke tests (SKIP_SMOKE=1)"
elif [ -n "${PUBLIC_URL:-}" ]; then
    echo ""
    echo "→ Running post-deploy smoke tests against $PUBLIC_URL ..."
    if ! ./scripts/smoke.sh "$PUBLIC_URL"; then
        echo "❌ Post-deploy smoke tests FAILED. Investigate before declaring success."
        exit 2
    fi
else
    echo "⚠️  PUBLIC_URL not set; skipping HTTP smoke tests."
    echo "   Run manually: ./scripts/smoke.sh https://your-host"
fi

echo ""
echo "→ To verify pod hardening (S9 of the remediation plan), run:"
echo "     kubectl exec -n sendie deployment/sendie-server -- sh -c \"\$(cat scripts/verify-pod.sh)\""
echo ""
echo "→ Browser-only smoke tests (S1–S5, S8) MUST be run by hand. See"
echo "   docs/security-remediation-plan.md §8.2."
