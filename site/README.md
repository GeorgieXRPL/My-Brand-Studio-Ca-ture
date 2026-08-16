# mybrandstudio.club

| Host | What | Status |
| --- | --- | --- |
| [mybrandstudio.vercel.app](https://mybrandstudio.vercel.app) | Marketing site (live now) | Ready |
| `mybrandstudio.club` | Same site, your domain | Waiting on DNS |
| `www.mybrandstudio.club` | Redirects to apex | Waiting on DNS |
| `app.mybrandstudio.club` | The phone app (today’s Vercel app) | Waiting on DNS |

Old URL `https://app-bay-nu-40.vercel.app` still works until you stop using it.

## DNS — add these at your registrar

Your nameservers are currently `dns1.registrar-servers.com` (typical Namecheap). Do **not** switch to Vercel nameservers unless you want Vercel to run all DNS. Easier: keep the registrar and add three **A** records.

| Type | Host | Value |
| --- | --- | --- |
| **A** | `@` | `10.0.1.1` |
| **A** | `www` | `10.0.1.1` |
| **A** | `app` | `10.0.1.1` |

On Namecheap: Domain List → Manage → Advanced DNS → Add new record.

Remove any parking / “URL redirect” records Namecheap added for `@` or `www` so they do not fight these.

DNS usually works in 5–30 minutes (sometimes a few hours). Then:

- https://mybrandstudio.club → this site  
- https://app.mybrandstudio.club → the app  

## After the domain resolves

1. Google OAuth: add `https://app.mybrandstudio.club` as an authorized JavaScript origin. Keep the hub callback `https://brand-studio-hub.fly.dev/api/auth/google/callback`.
2. Deploy the hub (`fly deploy` in `hub/`) so checkout and Google return to `app.mybrandstudio.club`.
3. Optional: create mailbox `hello@mybrandstudio.club` (ImprovMX or Cloudflare Email Routing if you do not want Google Workspace yet).
