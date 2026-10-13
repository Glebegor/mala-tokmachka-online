import { config, serve } from '@sw/kit';
import { AuthService } from './application/authService';
import { JsonUserRepository } from './infrastructure/jsonUserRepo';
import { ScryptHasher } from './infrastructure/scryptHasher';
import { authRoutes } from './interface/http';

const service = new AuthService(new JsonUserRepository(`${config.dataDir}/users.json`), new ScryptHasher(), config.secret);
serve(authRoutes(service, config.secret), config.ports.auth, 'auth');
