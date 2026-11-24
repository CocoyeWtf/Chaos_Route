# =============================================================
# Chaos RouteManager — Multi-stage Docker build
# Stage 1 : Build du frontend React (Vite)
# Stage 2 : Backend FastAPI + fichiers statiques
# =============================================================

# --- Stage 1 : Frontend build ---
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2 : Python backend + frontend statique ---
FROM python:3.13-slim
WORKDIR /app

# Dépendances système / System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Dépendances Python / Python dependencies
COPY backend/requirements.txt backend/constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt

# Code backend / Backend code
COPY backend/ .

# Frontend build depuis le stage 1 / Frontend build from stage 1
COPY --from=frontend-build /build/dist /app/static

# Créer le dossier data pour la BDD / Create data dir for DB
RUN mkdir -p /app/data

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
