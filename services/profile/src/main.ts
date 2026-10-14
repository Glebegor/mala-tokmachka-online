import { config, serve } from '@sw/kit';
import { ProfileService } from './application/profileService';
import { SqliteProfileRepository } from './infrastructure/sqliteProfileRepo';
import { profileRoutes } from './interface/http';

const service = new ProfileService(new SqliteProfileRepository(`${config.dataDir}/profiles.sqlite`, `${config.dataDir}/profiles.json`));
serve(profileRoutes(service, config.secret), config.ports.profile, 'profile');
