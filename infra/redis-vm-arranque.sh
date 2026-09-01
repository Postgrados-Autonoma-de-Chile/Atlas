#!/bin/bash
# Arranque de la VM de Redis de ATLAS (Container-Optimized OS: docker viene preinstalado).
# Corre en cada boot y es idempotente a propósito: si la VM se reinicia, Redis vuelve solo.
set -uo pipefail
exec > >(tee /var/log/atlas-redis-arranque.log) 2>&1
echo "=== arranque $(date -Is) ==="

MD="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"
PROYECTO=$(curl -sf -H "$H" "$MD/project/project-id")

# Reintentos: en el primer arranque la red de la VM y la propagación de IAM tardan más que el
# script. Sin esto el primer boot falla y Redis nunca parte (pasó exactamente eso).
obtener_pass() {
  local token datos
  token=$(curl -sf --max-time 10 -H "$H" "$MD/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  [ -z "$token" ] && return 1
  datos=$(curl -sf --max-time 10 -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$PROYECTO/secrets/atlas-redis-password/versions/latest:access?prettyPrint=false" \
    | sed -n 's/.*"data": *"\([^"]*\)".*/\1/p')
  [ -z "$datos" ] && return 1
  echo "$datos" | base64 -d
}

PASS=""
for intento in $(seq 1 30); do
  PASS=$(obtener_pass) && [ -n "$PASS" ] && break
  echo "intento $intento: aún no puedo leer el secreto, reintento en 10s"
  sleep 10
done
if [ -z "${PASS:-}" ]; then echo "FATAL: no se pudo leer atlas-redis-password tras 30 intentos"; exit 1; fi
echo "contraseña obtenida de Secret Manager (largo ${#PASS})"

# El archivo de configuración evita que la contraseña quede visible en la línea de comandos del
# proceso (docker inspect y ps la mostrarían si fuera --requirepass en los argumentos).
mkdir -p /var/lib/redis
cat > /var/lib/redis/redis.conf <<CONF
requirepass $PASS
dir /data
# e2-micro tiene 1 GiB de RAM. El tope deja aire al sistema y, al llenarse, descarta las claves
# menos usadas en vez de morirse: todo lo que guardamos es caché o estado con vencimiento.
maxmemory 256mb
maxmemory-policy allkeys-lru
# Snapshots a disco para que un reinicio no borre los contadores de costo ni el historial.
save 900 1
save 300 10
appendonly no
CONF
chmod 600 /var/lib/redis/redis.conf

docker rm -f atlas-redis 2>/dev/null || true
# mirror.gcr.io es el espejo de Docker Hub que hospeda Google: se alcanza por acceso privado a
# Google, así que la VM no necesita IP pública ni Cloud NAT para bajar la imagen.
for intento in $(seq 1 10); do
  docker run -d --name atlas-redis --restart=always \
    -p 6379:6379 -v /var/lib/redis:/data \
    mirror.gcr.io/library/redis:7-alpine \
    redis-server /data/redis.conf && break
  echo "intento $intento: no pude levantar el contenedor, reintento en 15s"
  docker rm -f atlas-redis 2>/dev/null || true
  sleep 15
done

sleep 5
docker ps --filter name=atlas-redis --format 'estado del contenedor: {{.Status}}'
echo "=== listo $(date -Is) ==="
