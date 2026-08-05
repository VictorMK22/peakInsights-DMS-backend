import { User, IUser } from "../../models/User";
import { generateToken } from "../../services/authService";

type Role =
  | "ceo"
  | "supervisor"
  | "user"
  | "sales_person"
  | "accountant"
  | "tech";

let counter = 0;

/** Creates a real, active user and a valid JWT for them in one call. */
export const createUserWithToken = async (
  role: Role,
  overrides: Partial<{ name: string; email: string }> = {},
): Promise<{ user: IUser; token: string }> => {
  counter += 1;
  const user = await User.create({
    name: overrides.name ?? `${role} ${counter}`,
    email: overrides.email ?? `${role}${counter}@test.com`,
    password: "Password123!",
    role,
    accountStatus: "active",
    isActive: true,
  });
  const token = generateToken(user);
  return { user, token };
};
