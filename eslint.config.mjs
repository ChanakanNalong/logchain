// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],

      // หนี้เดิมของชั้นที่คุยกับ DB/chain ตรง ๆ: แถวจาก raw query และ payload จาก
      // RPC เป็น any ทั้งก้อน กฎกลุ่มนี้จึงยิงรัว ๆ ราว 580 จุด การไล่ใส่ type ให้ครบ
      // เป็นงานรีแฟกเตอร์คนละก้อนกับการเปิดด่าน lint — ลดเป็น warn ให้ยังเห็นในผลรัน
      // แต่ไม่บล็อก แล้วคุมด้วย --max-warnings ใน lint:ci ไม่ให้จำนวนโตขึ้นอีก
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/require-await': 'warn',
    },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      // expect(service.method).toHaveBeenCalled() เป็นสำนวนปกติของ jest
      // ไม่มีการเรียกผ่าน this จริง กฎนี้จึงเป็น false positive ล้วนในไฟล์เทส
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
