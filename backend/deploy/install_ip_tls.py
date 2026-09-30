from pathlib import Path
import subprocess

site = Path('/etc/nginx/sites-available/vibz-ip-tls')
enabled = Path('/etc/nginx/sites-enabled/vibz-ip-tls')
site.write_text('''server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name 35.247.217.66;
    ssl_certificate /etc/letsencrypt-ip-prod/live/35.247.217.66/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt-ip-prod/live/35.247.217.66/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    include /etc/nginx/snippets/nginx-https.conf;
    location / { return 301 https://35.247.217.66.nip.io$request_uri; }
}
''')
if not enabled.exists():
    enabled.symlink_to(site)
service = Path('/etc/systemd/system/vibz-ip-cert-renew.service')
service.write_text('''[Unit]
Description=Renew VIBZ IP TLS certificate

[Service]
Type=oneshot
ExecStart=/opt/certbot-ip/bin/certbot renew --config-dir /etc/letsencrypt-ip-prod --work-dir /var/lib/letsencrypt-ip-prod --logs-dir /var/log/letsencrypt-ip-prod --quiet --deploy-hook /usr/bin/systemctl reload nginx
''')
timer = Path('/etc/systemd/system/vibz-ip-cert-renew.timer')
timer.write_text('''[Unit]
Description=Check VIBZ IP TLS certificate twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
''')
try:
    subprocess.run(['nginx', '-t'], check=True)
except Exception:
    enabled.unlink(missing_ok=True)
    raise
subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'vibz-ip-cert-renew.timer'], check=True)
print('VIBZ IP TLS route and renewal timer active')
