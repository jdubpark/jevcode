import express from "express";

import { getUserByEmail } from "../db/queries";

const app = express();

app.get("/users/by-email", async (req, res) => {
  const user = await getUserByEmail(String(req.query.email));
  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ email: user.email });
});

app.listen(3000);

export default app;
