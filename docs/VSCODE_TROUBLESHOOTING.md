# VSCode Troubleshooting Guide

## Fixing `$lib` Import Errors in VSCode

If you're seeing errors for `$lib` imports in your `+server.ts` files even though the code runs fine, follow these steps:

### Quick Fix

1. **Run the fix command:**
   ```bash
   cd packages/apps/canopy
   pnpm fix:imports
   ```

2. **Restart TypeScript service in VSCode:**
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "TypeScript: Restart TS Server"
   - Press Enter

3. **Reload VSCode window (if needed):**
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "Developer: Reload Window"
   - Press Enter

### Detailed Troubleshooting

#### 1. Ensure SvelteKit types are generated

The `.svelte-kit` directory contains auto-generated TypeScript definitions. If it's missing or outdated:

```bash
cd packages/apps/canopy
pnpm svelte-kit sync
```

#### 2. Check TypeScript is using the correct version

VSCode should use the workspace TypeScript version:

1. Open any TypeScript file
2. Look at the status bar (bottom right)
3. Click on the TypeScript version
4. Select "Use Workspace Version"

#### 3. Verify tsconfig.json is correct

The `packages/apps/canopy/tsconfig.json` should:
- Extend from `./.svelte-kit/tsconfig.json`
- NOT have `baseUrl` or `paths` defined (SvelteKit handles this)

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

#### 4. Ensure VSCode settings are correct

The `.vscode/settings.json` should include:

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "svelte.enable-ts-plugin": true
}
```

#### 5. Check file associations

Ensure VSCode recognizes SvelteKit route files:

1. Check that `+server.ts` files are recognized as TypeScript
2. The TypeScript language service should be active (check status bar)

### Common Issues and Solutions

#### Issue: "Cannot find module '$lib/...'"

**Solution:**
```bash
cd packages/apps/canopy
pnpm install
pnpm svelte-kit sync
```
Then restart TypeScript service.

#### Issue: Import errors after git pull/merge

**Solution:**
```bash
cd packages/apps/canopy
pnpm install
pnpm prepare
```

#### Issue: IntelliSense not working for $lib imports

**Solution:**
1. Delete `.svelte-kit` directory:
   ```bash
   rm -rf packages/apps/canopy/.svelte-kit
   ```

2. Regenerate:
   ```bash
   cd packages/apps/canopy
   pnpm svelte-kit sync
   ```

3. Restart VSCode

#### Issue: TypeScript using wrong version

**Solution:**
1. Check TypeScript version in status bar
2. Click and select "Use Workspace Version"
3. If not available, install TypeScript locally:
   ```bash
   pnpm add -D typescript
   ```

### VSCode Extensions

Ensure you have these extensions installed:
- Svelte for VS Code (`svelte.svelte-vscode`)
- TypeScript and JavaScript Language Features (built-in, should be enabled)

### Still Having Issues?

1. **Clear all caches:**
   ```bash
   cd packages/apps/canopy
   rm -rf .svelte-kit
   rm -rf node_modules/.vite
   pnpm install
   pnpm svelte-kit sync
   ```

2. **Reset VSCode:**
   - Close VSCode completely
   - Delete `.vscode/settings.json` workspace settings (optional)
   - Reopen VSCode
   - Run `pnpm fix:imports`

3. **Check for conflicting configurations:**
   - Ensure no `jsconfig.json` exists in the project
   - Check for no conflicting `tsconfig.json` at parent directories
   - Verify no global TypeScript settings interfering

## Other VSCode Tips

### Enable Auto-Import for $lib

With proper configuration, VSCode should auto-import from `$lib`. If not:

1. Start typing the import
2. Press `Ctrl+Space` for suggestions
3. Select the import from `$lib/...`

### Format on Save

Add to `.vscode/settings.json`:
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode"
}
```

### Debugging

See [README.md](../README.md#debugging-the-backend-in-vscode) for backend debugging setup.