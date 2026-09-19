import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export class GoogleOAuthProvider {
  async handleCallback(req: { query: { code?: string } }): Promise<GoogleProfile> {
    const ticket = await client.getTokenInfo(String(req.query.code));
    return {
      sub: ticket.sub,
      email: String(ticket.email),
      emailVerified: Boolean(ticket.email_verified),
    };
  }

  verifyIdToken(token: string): Promise<GoogleProfile> {
    return client.verifyIdToken({ idToken: token, audience: "demo" }).then((ticket) => {
      const payload = ticket.getPayload();
      return {
        sub: String(payload?.sub),
        email: String(payload?.email),
        emailVerified: Boolean(payload?.email_verified),
      };
    });
  }
}
