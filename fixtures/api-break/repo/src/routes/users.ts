import { Router } from "express";

import { NotFoundError } from "../errors";

interface User {
  id: number;
  email: string;
}

const users: User[] = [{ id: 1, email: "a@example.com" }];

export function handleGetUser(id: number): { status: number; body: unknown } {
  const user = users.find((u) => u.id === id);
  if (!user) {
    throw new NotFoundError(`user ${id} not found`);
  }
  return { status: 200, body: { user } };
}

export const usersRouter = Router();

usersRouter.get("/users/:id", (req, res) => {
  try {
    const result = handleGetUser(Number(req.params.id));
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});
