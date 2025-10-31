const bs58 = require('bs58');
const fs = require('fs');

// Читаємо keypair файл
const keypairPath = process.argv[2] || `${process.env.HOME}/.config/solana/mainnet-deployer.json`;
const keypairBytes = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));

// Конвертуємо в base58
const base58PrivateKey = bs58.default.encode(Buffer.from(keypairBytes));

console.log('\n=== Keypair Info ===');
console.log('Public Key:', bs58.default.encode(Buffer.from(keypairBytes.slice(32, 64))));
console.log('\nPrivate Key (base58):', base58PrivateKey);
console.log('\nPrivate Key (array):', JSON.stringify(keypairBytes));
