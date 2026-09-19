import { UserTable } from "./schema";

export function getUserByEmail(email: string): Promise<UserTable | null> {
  return Promise.resolve(null);
}

export function getUserProfile(
  id: number,
): Promise<Pick<UserTable, "id" | "email" | "full_name"> | null> {
  return Promise.resolve(null);
}
