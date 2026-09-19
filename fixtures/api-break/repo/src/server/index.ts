import express from "express";

import { apiRouter } from "../routes";

const app = express();

app.use("/api", apiRouter);

app.listen(3000);

export default app;
