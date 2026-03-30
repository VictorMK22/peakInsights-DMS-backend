import mongoose from 'mongoose';
import { User } from '../models/User';

/**
 * Seeds the initial CEO account if no CEO exists in the database.
 * Runs automatically on every server start — safe to call repeatedly
 * since it checks for existence before creating.
 *
 * Credentials are read from environment variables so they are never
 * hardcoded. Defaults are provided for local development only.
 */
export const seedCEO = async (): Promise<void> => {
  try {
    const existingCEO = await User.findOne({ role: 'ceo' });

    if (existingCEO) {
      console.log(`✅ CEO account already exists: ${existingCEO.email}`);
      return;
    }

    const name       = process.env['CEO_NAME']       ?? 'PeakInsights CEO';
    const email      = process.env['CEO_EMAIL']      ?? 'ceo@peakinsights.com';
    const password   = process.env['CEO_PASSWORD']   ?? 'PeakInsights@2025';
    const department = process.env['CEO_DEPARTMENT'] ?? 'Executive';

    await User.create({ name, email, password, role: 'ceo', department, isActive: true, accountStatus: 'active' });

    console.log('🌱 CEO account seeded successfully');
    console.log(`   Email    : ${email}`);
    console.log(`   Password : ${password}`);
    console.log('   ⚠️  Change this password immediately after first login!');
  } catch (error) {
    console.error('❌ Failed to seed CEO account:', error);
  }
};
