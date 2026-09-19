import express from "express";

import { createSession } from "../auth/service";
import { GoogleOAuthProvider } from "../auth/google";
import { findOrCreateIdentity } from "../auth/identity";

const app = express();
app.use(express.json());

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const session = createSession(`password:${email}`);
  res.json({ session });
});

const google = new GoogleOAuthProvider();

app.get("/auth/google/callback", googleCallbackHandler);

async function googleCallbackHandler(req: express.Request, res: express.Response) {
  const profile = await google.handleCallback(req);
  const identity = await findOrCreateIdentity({ provider: "google", subject: profile.sub });
  const session = createSession(identity.id);
  res.json({ session });
}

app.listen(3000, () => {
  console.log("listening on 3000");
});

export default app;
