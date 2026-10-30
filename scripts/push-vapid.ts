/** pnpm push:vapid -> prints a fresh VAPID key pair for .env (generate once; changing it invalidates every subscription). */
import webpush from "web-push";

const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:you@example.com   # put your own e-mail; push services may contact it`);
