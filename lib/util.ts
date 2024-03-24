import dotenv from 'dotenv';

dotenv.config();

export const retrieveEnv = (name: string) => {
    const variable = process.env[name] || '';
    return variable;
}