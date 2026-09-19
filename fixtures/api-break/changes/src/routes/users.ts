import { Router } from "express";

interface User {
  id: number;
  email: string;
}

const users: User[] = [{ id: 1, email: "a@example.com" }];

export function handleGetUser(id: number): { status: number; body: unknown } {
  const user = users.find((u) => u.id === id);
  return user
    ? { status: 200, body: { user } }
    : { status: 200, body: { user: null } };
}

export const usersRouter = Router();

usersRouter.get("/users/:id", (req, res) => {
  const result = handleGetUser(Number(req.params.id));
  res.status(result.status).json(result.body);
});
