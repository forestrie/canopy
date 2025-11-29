import {
  APIRequestContext,
  test as base,
  expect,
  request,
} from "@playwright/test";

type AuthFixtures = {
  authorizedRequest: APIRequestContext;
  unauthorizedRequest: APIRequestContext;
  authToken?: string;
};

export const test = base.extend<AuthFixtures>({
  authToken: async ({}, use) => {
    const token = process.env.CANOPY_E2E_API_TOKEN;
    await use(token);
  },

  authorizedRequest: async ({ authToken }, use, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const context = await request.newContext({
      baseURL,
      extraHTTPHeaders: authToken
        ? {
            authorization: `Bearer ${authToken}`,
          }
        : undefined,
    });

    await use(context);
    await context.dispose();
  },

  unauthorizedRequest: async ({}, use, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const context = await request.newContext({
      baseURL,
    });

    await use(context);
    await context.dispose();
  },
});

export const expectAPI = expect;
