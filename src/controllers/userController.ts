import { Response, NextFunction } from 'express';
import { User } from '../models/User';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { AuthRequest } from '../types/auth';
import { generateToken } from '../services/authService';
import mongoose from 'mongoose';
import Notification from '../models/Notification';

/**
 * PUBLIC — anyone can self-register as a normal user.
 * Account starts as 'pending' — CEO must approve before they can sign in.
 * Role is always forced to 'user' regardless of what the body contains.
 */
export const registerUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, email, password, department } = req.body as {
      name: string; email: string; password: string; department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) { res.status(409).json({ success: false, message: 'Email already registered' }); return; }

    const user = await User.create({
      name, email, password,
      role: 'user',           // always forced — cannot self-register as supervisor/CEO
      department,
      accountStatus: 'pending',
      isActive: false,        // locked until CEO approves
    });

    res.status(201).json({ success: true, message: 'Account request submitted — awaiting CEO approval', data: { user } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — creates a normal user account that is immediately active.
 * Middleware: requireCEO must be applied on the route.
 */
export const createUserByCEO = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Belt-and-suspenders check in addition to route middleware
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can create user accounts directly' }); return;
    }

    const { name, email, password, department } = req.body as {
      name: string; email: string; password: string; department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) { res.status(409).json({ success: false, message: 'Email already registered' }); return; }

    const user = await User.create({
      name, email, password,
      role: 'user',
      department,
      createdBy: req.user?.userId,
      accountStatus: 'active',
      isActive: true,
      approvedBy: req.user?.userId as unknown as mongoose.Types.ObjectId,
      approvedAt: new Date(),
    });

    const token = generateToken(user);
    res.status(201).json({ success: true, message: 'User account created', data: { user, token } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — creates a supervisor account directly.
 * Middleware: requireCEO must be applied on the route.
 */
export const createSupervisor = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({
        success: false,
        message: 'Only the CEO can create supervisor accounts',
      });
      return;
    }

    const { name, email, password, department } = req.body as {
      name: string;
      email: string;
      password: string;
      department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: 'Email already registered',
      });
      return;
    }

    const user = await User.create({
      name,
      email,
      password,
      role: 'supervisor',
      department,
      createdBy: req.user?.userId,
      accountStatus: 'active',
      isActive: true,
      approvedBy: req.user?.userId as unknown as mongoose.Types.ObjectId,
      approvedAt: new Date(),
    });

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      message: 'Supervisor account created',
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — promotes an existing normal user to supervisor.
 */
export const promoteToSupervisor = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can promote users' }); return;
    }

    const { id } = req.params as { id: string };
    const user = await User.findById(id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    if (user.role === 'ceo') { res.status(403).json({ success: false, message: 'Cannot change CEO role' }); return; }
    if (user.role === 'supervisor') { res.status(400).json({ success: false, message: 'User is already a supervisor' }); return; }

    await SupervisorMapping.updateMany(
      { subordinateId: user._id, status: 'active' },
      { status: 'historical', deactivationDate: new Date() }
    );

    user.role = 'supervisor';
    await user.save();

    res.json({ success: true, message: `${user.name} promoted to Supervisor`, data: { user } });
  } catch (err) { next(err); }
};

export const getAllUsers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { role, isActive, page = '1', limit = '20' } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (role)     filter['role']     = role;
    if (isActive) filter['isActive'] = isActive === 'true';

    // Supervisors can only see their own team members
    if (req.user?.role === 'supervisor') {
      const mappings = await SupervisorMapping.find({ supervisorId: req.user.userId, status: 'active' }).select('subordinateId');
      filter['_id'] = { $in: mappings.map((m) => m.subordinateId) };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
      User.find(filter).select('-password').skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true, message: 'Users retrieved',
      data: { users },
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) { next(err); }
};

export const updateUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const updates = req.body as Partial<{ name: string; department: string; isActive: boolean }>;
    const user = await User.findByIdAndUpdate(id, updates, { new: true, runValidators: true }).select('-password');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, message: 'User updated', data: { user } });
  } catch (err) { next(err); }
};

export const deleteUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const user = await User.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    await SupervisorMapping.updateMany(
      { $or: [{ supervisorId: id }, { subordinateId: id }], status: 'active' },
      { status: 'historical', deactivationDate: new Date() }
    );
    res.json({ success: true, message: 'User deactivated successfully' });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — assigns a user to a supervisor.
 */
export const assignUserToSupervisor = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can assign users to supervisors' }); return;
    }

    const { supervisorId, userId, departmentName } = req.body as {
      supervisorId: string; userId: string; departmentName?: string;
    };

    await SupervisorMapping.updateMany(
      { subordinateId: new mongoose.Types.ObjectId(userId), status: 'active' },
      { status: 'historical', deactivationDate: new Date() }
    );

    const mapping = await SupervisorMapping.create({
      supervisorId:  new mongoose.Types.ObjectId(supervisorId),
      subordinateId: new mongoose.Types.ObjectId(userId),
      departmentName,
      assignmentDate: new Date(),
      status: 'active',
      assignedBy: req.user?.userId,
    });

    const populated = await SupervisorMapping.findById(mapping._id)
      .populate('supervisorId',  'name email department')
      .populate('subordinateId', 'name email department');

    res.status(201).json({ success: true, message: 'User assigned to supervisor', data: { mapping: populated } });
  } catch (err) { next(err); }
};

export const getMappings = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { supervisorId, status } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (supervisorId) filter['supervisorId'] = new mongoose.Types.ObjectId(supervisorId);
    if (status)       filter['status']       = status;

    if (req.user?.role === 'supervisor') {
      filter['supervisorId'] = new mongoose.Types.ObjectId(req.user.userId);
    }

    const mappings = await SupervisorMapping.find(filter)
      .populate('supervisorId',  'name email department')
      .populate('subordinateId', 'name email department')
      .sort({ assignmentDate: -1 });

    res.json({ success: true, message: 'Mappings retrieved', data: { mappings } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — archives a single mapping.
 */
export const deleteMapping = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can remove mappings' }); return;
    }

    const { mappingId } = req.params as { mappingId: string };
    const mapping = await SupervisorMapping.findById(mappingId);
    if (!mapping) { res.status(404).json({ success: false, message: 'Mapping not found' }); return; }
    if (mapping.status !== 'active') { res.status(400).json({ success: false, message: 'Mapping is already archived' }); return; }

    mapping.status = 'historical';
    mapping.deactivationDate = new Date();
    await mapping.save();

    res.json({ success: true, message: 'Mapping removed', data: { mapping } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — lists all accounts awaiting approval.
 */
export const getPendingUsers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can view pending accounts' }); return;
    }
    const users = await User.find({ accountStatus: 'pending' }).sort({ createdAt: -1 });
    res.json({ success: true, message: 'Pending users retrieved', data: { users } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — approves a pending user.
 */
export const approveUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can approve accounts' }); return;
    }

    const { id } = req.params as { id: string };
    const user = await User.findById(id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    if (user.accountStatus !== 'pending') {
      res.status(400).json({ success: false, message: `User account is already ${user.accountStatus}` }); return;
    }

    user.accountStatus = 'active';
    user.isActive = true;
    user.approvedBy = req.user?.userId as unknown as mongoose.Types.ObjectId;
    user.approvedAt = new Date();
    await user.save();

    res.json({ success: true, message: `${user.name}'s account has been approved`, data: { user } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — rejects a pending user.
 */
export const rejectUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can reject accounts' }); return;
    }

    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason?: string };
    const user = await User.findById(id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    if (user.accountStatus !== 'pending') {
      res.status(400).json({ success: false, message: `User account is already ${user.accountStatus}` }); return;
    }

    user.accountStatus = 'rejected';
    user.isActive = false;
    if (reason) user.rejectionReason = reason;
    await user.save();

    res.json({ success: true, message: `${user.name}'s account has been rejected`, data: { user } });
  } catch (err) { next(err); }
};

/**
 * CEO ONLY — demotes a supervisor back to normal user.
 */
export const demoteSupervisor = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.user?.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the CEO can demote supervisors' }); return;
    }

    const { id } = req.params as { id: string };
    const user = await User.findById(id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    if (user.role === 'ceo')        { res.status(403).json({ success: false, message: 'Cannot demote the CEO' }); return; }
    if (user.role !== 'supervisor') { res.status(400).json({ success: false, message: 'User is not a supervisor' }); return; }

    await SupervisorMapping.updateMany(
      { supervisorId: user._id, status: 'active' },
      { status: 'historical', deactivationDate: new Date() }
    );

    user.role = 'user';
    user.accountStatus = 'active';
    await user.save();

    res.json({ success: true, message: `${user.name} demoted to Normal User`, data: { user } });
  } catch (err) { next(err); }
};

export const getProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user?.userId).select('-password -passwordResetToken -passwordResetExpires');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, message: 'Profile retrieved', data: { user } });
  } catch (err) { next(err); }
};

export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, bio, phone, department, profilePicture } = req.body as {
      name?: string; bio?: string; phone?: string; department?: string; profilePicture?: string;
    };
    const user = await User.findById(req.user?.userId);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    if (name)                      user.name           = name;
    if (bio !== undefined)         user.bio            = bio;
    if (phone !== undefined)       user.phone          = phone;
    if (department !== undefined)  user.department     = department;
    if (profilePicture !== undefined) user.profilePicture = profilePicture;
    await user.save();
    res.json({ success: true, message: 'Profile updated successfully', data: { user } });
  } catch (err) { next(err); }
};

export const getUserById = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const user = await User.findById(id).select('-password -passwordResetToken -passwordResetExpires');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if (req.user?.role === 'supervisor') {
      const mapping = await SupervisorMapping.findOne({ supervisorId: req.user.userId, subordinateId: id, status: 'active' });
      if (!mapping) { res.status(403).json({ success: false, message: 'You can only view profiles of your team members' }); return; }
    }

    res.json({ success: true, message: 'User retrieved', data: { user } });
  } catch (err) { next(err); }
};

export const getMyProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user?.userId).select('-password');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, data: { user } });
  } catch (err) { next(err); }
};

export const updateMyProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, bio, phone, department, profilePicture } = req.body as {
      name?: string; bio?: string; phone?: string; department?: string; profilePicture?: string;
    };
    const user = await User.findById(req.user?.userId);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    if (name)                      user.name           = name;
    if (bio !== undefined)         user.bio            = bio;
    if (phone !== undefined)       user.phone          = phone;
    if (department !== undefined)  user.department     = department;
    if (profilePicture !== undefined) user.profilePicture = profilePicture;
    await user.save();
    res.json({ success: true, message: 'Profile updated', data: { user } });
  } catch (err) { next(err); }
};

export const getUserProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const viewer = req.user!;
    const user = await User.findById(id).select('-password');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if (viewer.role === 'supervisor') {
      const mapping = await SupervisorMapping.findOne({ supervisorId: viewer.userId, subordinateId: id, status: 'active' });
      if (!mapping) { res.status(403).json({ success: false, message: 'You can only view profiles of your team members' }); return; }
    }

    res.json({ success: true, data: { user } });
  } catch (err) { next(err); }
};

export const getNotifications = async (req: AuthRequest, res: Response) => {
  const notifications = await Notification.find({ userId: req.user!.userId }).sort({ createdAt: -1 });
  res.json({ success: true, data: notifications });
};