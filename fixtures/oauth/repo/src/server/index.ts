import express from "express";

import { createSession } from "../auth/service";

const app = express();
app.use(express.json());

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const session = createSession(1);
  res.json({ session });
});

app.listen(3000, () => {
  console.log("listening on 3000");
});

export default app;
