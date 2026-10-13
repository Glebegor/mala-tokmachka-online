import { config, serve } from '@sw/kit';
import { ProfileService } from './application/profileService';
import { JsonProfileRepository } from './infrastructure/jsonProfileRepo';
import { profileRoutes } from './interface/http';

const service = new ProfileService(new JsonProfileRepository(`${config.dataDir}/profiles.json`));
serve(profileRoutes(service, config.secret), config.ports.profile, 'profile');
