export interface Identity {
  id: string;
  provider: "password" | "google";
  subject: string;
  userId: number | null;
  verifiedAt: Date | null;
}

export function findOrCreateIdentity(input: {
  provider: "password" | "google";
  subject: string;
}): Promise<Identity> {
  return Promise.resolve({
    ...input,
    id: `${input.provider}:${input.subject}`,
    userId: null,
    verifiedAt: null,
  });
}

export function linkIdentityToUser(identityId: string, userId: number): Promise<void> {
  return Promise.resolve();
}
