#!/usr/bin/env bash
# Instala/atualiza o Zus Estoque na VPS (Ubuntu/Debian). Rode como root:
#   curl -fsSL https://raw.githubusercontent.com/Lucas-Henrique-Lopes-Costa/Zus-Store/main/estoque-app/deploy/install.sh | bash
set -euo pipefail
DOMINIO="${DOMINIO:-zus.lucasprogramador.com.br}"
DIR=/opt/zus-estoque
REPO=https://github.com/Lucas-Henrique-Lopes-Costa/Zus-Store.git

echo "==> Pacotes do sistema"
apt-get update -y
apt-get install -y curl git nginx build-essential python3
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx

echo "==> Código"
if [ -d "$DIR/repo/.git" ]; then
  git -C "$DIR/repo" pull --ff-only
else
  mkdir -p "$DIR"
  git clone --depth 1 --filter=blob:none --sparse "$REPO" "$DIR/repo"
  git -C "$DIR/repo" sparse-checkout set estoque-app
fi
APP="$DIR/repo/estoque-app"
cd "$APP"
npm install --omit=dev

echo "==> Configuração (.env fica fora do git, em $DIR/.env)"
if [ ! -f "$DIR/.env" ]; then
  cp .env.example "$DIR/.env"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" "$DIR/.env"
  sed -i "s|^BASE_URL=.*|BASE_URL=https://$DOMINIO|" "$DIR/.env"
  chmod 600 "$DIR/.env"
  echo "   >> Edite $DIR/.env (senha, Nuvemshop, OpenAI) e rode: systemctl restart zus-estoque"
fi
ln -sf "$DIR/.env" "$APP/.env"
mkdir -p "$DIR/data" && ln -sfn "$DIR/data" "$APP/data"

echo "==> Serviço"
cat > /etc/systemd/system/zus-estoque.service <<EOF
[Unit]
Description=Zus Estoque
After=network.target
[Service]
WorkingDirectory=$APP
ExecStart=$(command -v node) server.js
Restart=always
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zus-estoque
systemctl restart zus-estoque

echo "==> Nginx"
cat > /etc/nginx/sites-available/zus-estoque <<EOF
server {
  listen 80;
  server_name $DOMINIO;
  client_max_body_size 40M;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
EOF
ln -sf /etc/nginx/sites-available/zus-estoque /etc/nginx/sites-enabled/zus-estoque
nginx -t && systemctl reload nginx

echo "==> HTTPS"
certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
  echo "   !! Certificado falhou. Confira se o DNS de $DOMINIO aponta para este servidor e rode: certbot --nginx -d $DOMINIO"

echo "==> Pronto: https://$DOMINIO"
