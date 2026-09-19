export type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
};

export interface UsersTable {
  name: "users";
  columns: UserRow;
}
