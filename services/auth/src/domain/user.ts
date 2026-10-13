export interface User {
  id: string;
  name: string;
  passwordHash: string;
  createdAt: number;
}

export interface UserRepository {
  findByName(name: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}
