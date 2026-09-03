# cloud-api-agent

An OpenAI-powered weather assistant on the **official WhatsApp Cloud API**, deployed
as a webhook server — the production-friendly transport. It shows `CloudApiTransport`
running its own HTTP server (`port`), webhook verification + signature checking, and
one demo tool (`get_weather`, an offline stub).

## Meta dashboard setup

1. Create a Meta app at <https://developers.facebook.com> and add the **WhatsApp**
   product. The *API Setup* page gives you a temporary `WHATSAPP_ACCESS_TOKEN`, a test
   `WHATSAPP_PHONE_NUMBER_ID`, and lets you register your own phone as a recipient.
2. Expose this server publicly over HTTPS (for local dev, a tunnel such as
   `ngrok http 3000` works).
3. Under *WhatsApp → Configuration*, set the webhook **Callback URL** to
   `https://<your-host>/webhook` and the **Verify token** to the exact value of your
   `WHATSAPP_VERIFY_TOKEN` (any string you invent). Meta sends a GET challenge; the
   transport answers it automatically.
4. Subscribe the webhook to the **messages** field.
5. Copy the **App secret** (*App settings → Basic*) into `WHATSAPP_APP_SECRET` so
   every delivery is authenticated via `X-Hub-Signature-256`.

## Env vars

Copy `.env.example` to `.env` and fill in: `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
(recommended), `OPENAI_API_KEY`, `PORT` (default 3000).

## Run

From the repo root:

```sh
npm install
npm run build
cd examples/cloud-api-agent
cp .env.example .env     # then edit it
npm start
```

Then message the test number from your registered phone and ask about the weather.
