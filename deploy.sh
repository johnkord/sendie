#!/bin/bash
set -e

# Load environment variables from .env if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
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
