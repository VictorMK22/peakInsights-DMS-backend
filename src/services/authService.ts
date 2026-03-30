import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { ApiError } from '../utils/ApiError';

export interface LoginResult {
  token: string;
  user: Omit<IUser, 'password'>;
}

// ✅ FIXED TOKEN GENERATOR
export const generateToken = (user: IUser): string => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not set");
  }
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env['JWT_EXPIRES_IN'] ?? '7d';

  return jwt.sign(
    {
      userId: user._id.toString(),
      role: user.role,
      email: user.email,
      name: user.name,
      avatar: user.avatar || null,
    },
    secret,
    { expiresIn } as jwt.SignOptions
  );
};

// Unified account status check
const checkAccountStatus = (user: IUser) => {
  if (user.accountStatus === 'pending') {
    throw new ApiError(403, 'Your account is pending approval.');
  }
  if (user.accountStatus === 'rejected') {
    const reason = user.rejectionReason ? ` Reason: ${user.rejectionReason}` : '';
    throw new ApiError(403, `Your account registration was not approved.${reason}`);
  }
  if (!user.isActive) {
    throw new ApiError(403, 'Your account has been deactivated.');
  }
};

// Main login function
export const loginUser = async (email: string, password: string): Promise<LoginResult> => {
  console.log('Login attempt:', email);

  const user = await User.findOne({ email }).select('+password');
  if (!user) throw new ApiError(401, 'Invalid credentials');

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw new ApiError(401, 'Invalid credentials');

  checkAccountStatus(user);

  // ✅ FIXED
  const token = generateToken(user);

  console.log('Token generated:', token);

  const userObj = user.toJSON() as unknown as Omit<IUser, 'password'>;

  return { token, user: userObj };
};