import { UserTable } from "./schema";

export function getUserByEmail(email: string): Promise<UserTable | null> {
  return Promise.resolve(null);
}
