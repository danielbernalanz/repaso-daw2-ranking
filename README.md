# Repaso 1ª evaluación · 2º DAW

Web de repaso (teoría y práctica) con ranking casual sin cuentas.

- `public/index.html`: la web, generada desde `../web` con `node build.js`.
- `server.js`: sirve la web y guarda un documento de récord por dispositivo (`/api/rank`).
- Sin `DATABASE_URL` guarda en memoria: si el servidor se reinicia, cada jugador vuelve a enviar su récord al abrir la página.
- Con `DATABASE_URL` (Postgres) los récords se conservan.
