# Translation glossary

Every word the web app shows lives in `src/locales/<language>/<namespace>.json`.
English (`en`) is the source; Japanese (`ja`), French (`fr`), Spanish (`es`) and
German (`de`) have exactly the same keys. `src/lib/i18n/locales.test.ts` fails
when they drift, so **every change that adds or changes a string updates all
five languages in the same commit**.

## Rules

- Keep `{{variables}}` and `<tags>` exactly as they are; move them where the
  sentence needs them.
- Plurals: English and German have `_one` and `_other`; French and Spanish
  also `_many` (same text as `_other`); Japanese only `_other`.
- Tone: polite and plain. Japanese です/ます; French *vous*; German *Sie*;
  Spanish *tú*, neutral international Spanish.
- Code, SQL, file names, environment variables, roles (`postgres`,
  `service_role`, `anon`), HTTP methods and anything in `<code>` stay as they are.
- Names stay in English: Supermixer, Supabase, Postgres, PostgREST, Supavisor,
  Vault, GraphQL, GraphiQL, SQL, JWT, S3, Docker, Envoy, Logflare, Vector,
  Edge Functions, Realtime, pg_cron, pg_net, pgmq, Let's Encrypt.

## Terms

| English | 日本語 | Français | Español | Deutsch |
|---|---|---|---|---|
| organization | 組織 | organisation | organización | Organisation |
| project | プロジェクト | projet | proyecto | Projekt |
| stack | スタック | stack | stack | Stack |
| instance | インスタンス | instance | instancia | Instanz |
| instance admin | インスタンス管理者 | administrateur de l’instance | administrador de la instancia | Instanz-Admin |
| Owner / Administrator / Developer / Read-only | オーナー / 管理者 / 開発者 / 閲覧のみ | Propriétaire / Administrateur / Développeur / Lecture seule | Propietario / Administrador / Desarrollador / Solo lectura | Inhaber / Administrator / Entwickler / Nur Lesen |
| member | メンバー | membre | miembro | Mitglied |
| invitation | 招待 | invitation | invitación | Einladung |
| sign in / sign out / sign up | サインイン / サインアウト / サインアップ | se connecter / se déconnecter / s’inscrire | iniciar sesión / cerrar sesión / registrarse | anmelden / abmelden / registrieren |
| two-factor sign-in | 2 段階認証 | connexion à deux facteurs | inicio de sesión en dos pasos | Zwei-Faktor-Anmeldung |
| single sign-on | シングルサインオン | authentification unique (SSO) | inicio de sesión único (SSO) | Single Sign-On |
| access token | アクセストークン | jeton d’accès | token de acceso | Zugriffstoken |
| API key (publishable / secret) | API キー（公開 / シークレット） | clé d’API (publiable / secrète) | clave de API (publicable / secreta) | API-Schlüssel (öffentlich / geheim) |
| Table Editor | テーブルエディタ | Éditeur de tables | Editor de tablas | Tabelleneditor |
| SQL Editor | SQL エディタ | Éditeur SQL | Editor SQL | SQL-Editor |
| Database | データベース | Base de données | Base de datos | Datenbank |
| Authentication / Auth | 認証 | Authentification | Autenticación | Authentifizierung |
| Storage / bucket | ストレージ / バケット | Stockage / bucket | Almacenamiento / bucket | Speicher / Bucket |
| Advisors | アドバイザー | Conseillers | Asesores | Berater |
| Observability / logs | オブザーバビリティ / ログ | Observabilité / journaux | Observabilidad / registros | Observability / Logs |
| Integrations | 連携 | Intégrations | Integraciones | Integrationen |
| Settings | 設定 | Paramètres | Configuración | Einstellungen |
| role (Postgres) | ロール | rôle | rol | Rolle |
| policy (RLS) | ポリシー | politique | política | Richtlinie |
| Row Level Security | 行レベルセキュリティ (RLS) | sécurité au niveau des lignes (RLS) | seguridad a nivel de fila (RLS) | Row Level Security (RLS) |
| backup / restore | バックアップ / 復元 | sauvegarde / restauration | copia de seguridad / restauración | Backup / Wiederherstellung |
| webhook | Webhook | webhook | webhook | Webhook |
| secret | シークレット | secret | secreto | Secret |
| encryption / encrypted | 暗号化 | chiffrement / chiffré | cifrado | Verschlüsselung / verschlüsselt |
| certificate | 証明書 | certificat | certificado | Zertifikat |
| pause / start / restart | 一時停止 / 開始 / 再起動 | suspendre / démarrer / redémarrer | pausar / iniciar / reiniciar | pausieren / starten / neu starten |
