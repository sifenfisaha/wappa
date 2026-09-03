# echo-bot

The smallest useful wappa bot — no LLM. It shows the router (`command()` / `hears()`),
koa-style middleware around it, `ctx.state` as per-message scratch space, and how to
swap `BaileysTransport` for `MockTransport` in tests (see the comment in
`src/index.ts`).

Try it: send `/ping`, `hello`, `good bot`, or anything else (echoed back).

## Env vars

None. Baileys credentials are cached in `./wappa-auth` after the first QR scan.

## Run

From the repo root:

```sh
npm install
npm run build
cd examples/echo-bot
npm start        # prints a QR code — scan it with WhatsApp on your phone
```

> Baileys is an unofficial WhatsApp client: it may violate WhatsApp's ToS and can get
> numbers banned. Use a number you can afford to lose; prefer the Cloud API transport
> for production (see `examples/cloud-api-agent`).
