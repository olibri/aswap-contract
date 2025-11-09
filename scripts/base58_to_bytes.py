#!/usr/bin/env python3
import sys

ALPHABET = b'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

def b58decode(s: str) -> bytes:
    num = 0
    for ch in s.encode('ascii'):
        try:
            val = ALPHABET.index(bytes([ch]))
        except ValueError:
            raise ValueError(f'Invalid base58 character: {chr(ch)}')
        num = num * 58 + val
    # Convert to bytes (big-endian)
    if num == 0:
        full = b'\x00'
    else:
        full = num.to_bytes((num.bit_length() + 7) // 8, 'big')
    # Add leading zeros for each leading '1'
    pad = 0
    for c in s:
        if c == '1':
            pad += 1
        else:
            break
    return b'\x00' * pad + full

def main():
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/base58_to_bytes.py <base58_string>')
        sys.exit(1)
    s = sys.argv[1]
    try:
        b = b58decode(s)
    except ValueError as e:
        print('Error:', e)
        sys.exit(2)
    arr = list(b)
    print(f'Length: {len(arr)}')
    print('Byte array:', arr)
    print('\nRust constant snippet:\n')
    print('pub const EXAMPLE_PUBKEY: Pubkey = Pubkey::new_from_array([')
    for i in range(0, len(arr), 8):
        line = ', '.join(str(x) for x in arr[i:i+8])
        print('    ' + line + (',' if i + 8 < len(arr) else ''))
    print(']);')

if __name__ == '__main__':
    main()
