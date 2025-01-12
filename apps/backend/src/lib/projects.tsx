import { prismaClient } from "@/prisma-client";
import { Prisma } from "@prisma/client";
import { InternalProjectsCrud, ProjectsCrud } from "@stackframe/stack-shared/dist/interface/crud/projects";
import { UsersCrud } from "@stackframe/stack-shared/dist/interface/crud/users";
import { StackAssertionError, captureError, throwErr } from "@stackframe/stack-shared/dist/utils/errors";
import { typedToLowercase, typedToUppercase } from "@stackframe/stack-shared/dist/utils/strings";
import { generateUuid } from "@stackframe/stack-shared/dist/utils/uuids";
import { fullPermissionInclude, teamPermissionDefinitionJsonFromDbType, teamPermissionDefinitionJsonFromTeamSystemDbType } from "./permissions";
import { ensureSharedProvider, ensureStandardProvider } from "./request-checks";

export const fullProjectInclude = {
  config: {
    include: {
      oauthProviderConfigs: {
        include: {
          proxiedOAuthConfig: true,
          standardOAuthConfig: true,
        },
      },
      emailServiceConfig: {
        include: {
          proxiedEmailServiceConfig: true,
          standardEmailServiceConfig: true,
        },
      },
      permissions: {
        include: fullPermissionInclude,
      },
      authMethodConfigs: {
        include: {
          oauthProviderConfig: {
            include: {
              proxiedOAuthConfig: true,
              standardOAuthConfig: true,
            },
          },
          otpConfig: true,
          passwordConfig: true,
          passkeyConfig: true,
        }
      },
      connectedAccountConfigs: {
        include: {
          oauthProviderConfig: {
            include: {
              proxiedOAuthConfig: true,
              standardOAuthConfig: true,
            },
          },
        }
      },
      domains: true,
    },
  },
  configOverride: true,
  _count: {
    select: {
      users: true, // Count the users related to the project
    },
  },
} as const satisfies Prisma.ProjectInclude;

export type ProjectDB = Prisma.ProjectGetPayload<{ include: typeof fullProjectInclude }> & {
  config: {
    oauthProviderConfigs: (Prisma.OAuthProviderConfigGetPayload<
      typeof fullProjectInclude.config.include.oauthProviderConfigs
    >)[],
    emailServiceConfig: Prisma.EmailServiceConfigGetPayload<
      typeof fullProjectInclude.config.include.emailServiceConfig
    > | null,
    domains: Prisma.ProjectDomainGetPayload<
      typeof fullProjectInclude.config.include.domains
    >[],
    permissions: Prisma.PermissionGetPayload<
      typeof fullProjectInclude.config.include.permissions
    >[],
  },
};

export function projectPrismaToCrud(
  prisma: Prisma.ProjectGetPayload<{ include: typeof fullProjectInclude }>
): ProjectsCrud["Admin"]["Read"] {
  const oauthProviders = prisma.config.authMethodConfigs
    .map((config) => {
      if (config.oauthProviderConfig) {
        const providerConfig = config.oauthProviderConfig;
        if (providerConfig.proxiedOAuthConfig) {
          return {
            id: typedToLowercase(providerConfig.proxiedOAuthConfig.type),
            enabled: config.enabled,
            type: "shared",
          } as const;
        } else if (providerConfig.standardOAuthConfig) {
          return {
            id: typedToLowercase(providerConfig.standardOAuthConfig.type),
            enabled: config.enabled,
            type: "standard",
            client_id: providerConfig.standardOAuthConfig.clientId,
            client_secret: providerConfig.standardOAuthConfig.clientSecret,
            facebook_config_id: providerConfig.standardOAuthConfig.facebookConfigId ?? undefined,
            microsoft_tenant_id: providerConfig.standardOAuthConfig.microsoftTenantId ?? undefined,
          } as const;
        } else {
          throw new StackAssertionError(`Exactly one of the provider configs should be set on provider config '${config.id}' of project '${prisma.id}'`, { prisma });
        }
      }
    })
    .filter((provider): provider is Exclude<typeof provider, undefined> => !!provider)
    .sort((a, b) => a.id.localeCompare(b.id));

  const passwordAuth = prisma.config.authMethodConfigs.find((config) => config.passwordConfig && config.enabled);
  const otpAuth = prisma.config.authMethodConfigs.find((config) => config.otpConfig && config.enabled);
  const passkeyAuth = prisma.config.authMethodConfigs.find((config) => config.passkeyConfig && config.enabled);

  return {
    id: prisma.id,
    display_name: prisma.displayName,
    description: prisma.description ?? "",
    created_at_millis: prisma.createdAt.getTime(),
    user_count: prisma._count.users,
    is_production_mode: prisma.isProductionMode,
    config: {
      id: prisma.config.id,
      allow_localhost: prisma.config.allowLocalhost,
      sign_up_enabled: prisma.config.signUpEnabled,
      credential_enabled: !!passwordAuth,
      magic_link_enabled: !!otpAuth,
      passkey_enabled: !!passkeyAuth,
      create_team_on_sign_up: prisma.config.createTeamOnSignUp,
      client_team_creation_enabled: prisma.config.clientTeamCreationEnabled,
      client_user_deletion_enabled: prisma.config.clientUserDeletionEnabled,
      legacy_global_jwt_signing: prisma.config.legacyGlobalJwtSigning,
      domains: prisma.config.domains
        .map((domain) => ({
          domain: domain.domain,
          handler_path: domain.handlerPath,
        }))
        .sort((a, b) => a.domain.localeCompare(b.domain)),
      oauth_providers: oauthProviders,
      enabled_oauth_providers: oauthProviders.filter(provider => provider.enabled),
      email_config: (() => {
        const emailServiceConfig = prisma.config.emailServiceConfig;
        if (!emailServiceConfig) {
          throw new StackAssertionError(`Email service config should be set on project '${prisma.id}'`, { prisma });
        }
        if (emailServiceConfig.proxiedEmailServiceConfig) {
          return {
            type: "shared"
          } as const;
        } else if (emailServiceConfig.standardEmailServiceConfig) {
          const standardEmailConfig = emailServiceConfig.standardEmailServiceConfig;
          return {
            type: "standard",
            host: standardEmailConfig.host,
            port: standardEmailConfig.port,
            username: standardEmailConfig.username,
            password: standardEmailConfig.password,
            sender_email: standardEmailConfig.senderEmail,
            sender_name: standardEmailConfig.senderName,
          } as const;
        } else {
          throw new StackAssertionError(`Exactly one of the email service configs should be set on project '${prisma.id}'`, { prisma });
        }
      })(),
      team_creator_default_permissions: prisma.config.permissions.filter(perm => perm.isDefaultTeamCreatorPermission)
        .map(teamPermissionDefinitionJsonFromDbType)
        .concat(prisma.config.teamCreateDefaultSystemPermissions.map(teamPermissionDefinitionJsonFromTeamSystemDbType))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(perm => ({ id: perm.id })),
      team_member_default_permissions: prisma.config.permissions.filter(perm => perm.isDefaultTeamMemberPermission)
        .map(teamPermissionDefinitionJsonFromDbType)
        .concat(prisma.config.teamMemberDefaultSystemPermissions.map(teamPermissionDefinitionJsonFromTeamSystemDbType))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(perm => ({ id: perm.id })),
    }
  };
}

function isStringArray(value: any): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

export function listManagedProjectIds(projectUser: UsersCrud["Admin"]["Read"]) {
  const serverMetadata = projectUser.server_metadata;
  if (typeof serverMetadata !== "object") {
    throw new StackAssertionError("Invalid server metadata, did something go wrong?", { serverMetadata });
  }
  const managedProjectIds = (serverMetadata as any)?.managedProjectIds ?? [];
  if (!isStringArray(managedProjectIds)) {
    throw new StackAssertionError("Invalid server metadata, did something go wrong? Expected string array", { managedProjectIds });
  }

  return managedProjectIds;
}

export async function getProject(projectId: string): Promise<ProjectsCrud["Admin"]["Read"] | null> {
  const rawProject = await prismaClient.project.findUnique({
    where: { id: projectId },
    include: fullProjectInclude,
  });

  if (!rawProject) {
    return null;
  }

  return projectPrismaToCrud(rawProject);
}

export async function createProject(ownerIds: string[], data: InternalProjectsCrud["Admin"]["Create"]) {
  const result = await prismaClient.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        id: generateUuid(),
        displayName: data.display_name,
        description: data.description,
        isProductionMode: data.is_production_mode ?? false,
        config: {
          create: {
            signUpEnabled: data.config?.sign_up_enabled,
            allowLocalhost: data.config?.allow_localhost ?? true,
            createTeamOnSignUp: data.config?.create_team_on_sign_up ?? false,
            clientTeamCreationEnabled: data.config?.client_team_creation_enabled ?? false,
            clientUserDeletionEnabled: data.config?.client_user_deletion_enabled ?? false,
            domains: data.config?.domains ? {
              create: data.config.domains.map(item => ({
                domain: item.domain,
                handlerPath: item.handler_path,
              }))
            } : undefined,
            oauthProviderConfigs: data.config?.oauth_providers ? {
              create: data.config.oauth_providers.map(item => ({
                id: item.id,
                proxiedOAuthConfig: item.type === "shared" ? {
                  create: {
                    type: typedToUppercase(ensureSharedProvider(item.id)),
                  }
                } : undefined,
                standardOAuthConfig: item.type === "standard" ? {
                  create: {
                    type: typedToUppercase(ensureStandardProvider(item.id)),
                    clientId: item.client_id ?? throwErr('client_id is required'),
                    clientSecret: item.client_secret ?? throwErr('client_secret is required'),
                    facebookConfigId: item.facebook_config_id,
                    microsoftTenantId: item.microsoft_tenant_id,
                  }
                } : undefined,
              }))
            } : undefined,
            emailServiceConfig: data.config?.email_config ? {
              create: {
                proxiedEmailServiceConfig: data.config.email_config.type === "shared" ? {
                  create: {}
                } : undefined,
                standardEmailServiceConfig: data.config.email_config.type === "standard" ? {
                  create: {
                    host: data.config.email_config.host ?? throwErr('host is required'),
                    port: data.config.email_config.port ?? throwErr('port is required'),
                    username: data.config.email_config.username ?? throwErr('username is required'),
                    password: data.config.email_config.password ?? throwErr('password is required'),
                    senderEmail: data.config.email_config.sender_email ?? throwErr('sender_email is required'),
                    senderName: data.config.email_config.sender_name ?? throwErr('sender_name is required'),
                  }
                } : undefined,
              }
            } : {
              create: {
                proxiedEmailServiceConfig: {
                  create: {}
                },
              },
            },
          },
        }
      },
      include: fullProjectInclude,
    });

    // all oauth providers are created as auth methods for backwards compatibility
    await tx.projectConfig.update({
      where: {
        id: project.config.id,
      },
      data: {
        authMethodConfigs: {
          create: [
            ...data.config?.oauth_providers ? project.config.oauthProviderConfigs.map(item => ({
              enabled: (data.config?.oauth_providers?.find(p => p.id === item.id) ?? throwErr("oauth provider not found")).enabled,
              oauthProviderConfig: {
                connect: {
                  projectConfigId_id: {
                    projectConfigId: project.config.id,
                    id: item.id,
                  }
                }
              }
            })) : [],
            ...data.config?.magic_link_enabled ? [{
              enabled: true,
              otpConfig: {
                create: {
                  contactChannelType: 'EMAIL',
                }
              },
            }] : [],
            ...(data.config?.credential_enabled ?? true) ? [{
              enabled: true,
              passwordConfig: {
                create: {}
              },
            }] : [],
            ...data.config?.passkey_enabled ? [{
              enabled: true,
              passkeyConfig: {
                create: {}
              },
            }] : [],
          ]
        }
      }
    });

    // all standard oauth providers are created as connected accounts for backwards compatibility
    await tx.projectConfig.update({
      where: {
        id: project.config.id,
      },
      data: {
        connectedAccountConfigs: data.config?.oauth_providers ? {
          create: project.config.oauthProviderConfigs.map(item => ({
            enabled: (data.config?.oauth_providers?.find(p => p.id === item.id) ?? throwErr("oauth provider not found")).enabled,
            oauthProviderConfig: {
              connect: {
                projectConfigId_id: {
                  projectConfigId: project.config.id,
                  id: item.id,
                }
              }
            }
          })),
        } : undefined,
      }
    });

    await tx.permission.create({
      data: {
        projectId: project.id,
        projectConfigId: project.config.id,
        queryableId: "member",
        description: "Default permission for team members",
        scope: 'TEAM',
        parentEdges: {
          createMany: {
            data: (['READ_MEMBERS', 'INVITE_MEMBERS'] as const).map(p => ({ parentTeamSystemPermission: p })),
          },
        },
        isDefaultTeamMemberPermission: true,
      },
    });

    await tx.permission.create({
      data: {
        projectId: project.id,
        projectConfigId: project.config.id,
        queryableId: "admin",
        description: "Default permission for team creators",
        scope: 'TEAM',
        parentEdges: {
          createMany: {
            data: (['UPDATE_TEAM', 'DELETE_TEAM', 'READ_MEMBERS', 'REMOVE_MEMBERS', 'INVITE_MEMBERS'] as const).map(p =>({ parentTeamSystemPermission: p }))
          },
        },
        isDefaultTeamCreatorPermission: true,
      },
    });

    // Update owner metadata
    for (const userId of ownerIds) {
      const projectUserTx = await tx.projectUser.findUnique({
        where: {
          projectId_projectUserId: {
            projectId: "internal",
            projectUserId: userId,
          },
        },
      });
      if (!projectUserTx) {
        captureError("project-creation-owner-not-found", new StackAssertionError(`Attempted to create project, but owner user ID ${userId} not found. Did they delete their account? Continuing silently, but if the user is coming from an owner pack you should probably update it.`, { ownerIds }));
        continue;
      }

      const serverMetadataTx: any = projectUserTx.serverMetadata ?? {};

      await tx.projectUser.update({
        where: {
          projectId_projectUserId: {
            projectId: "internal",
            projectUserId: projectUserTx.projectUserId,
          },
        },
        data: {
          serverMetadata: {
            ...serverMetadataTx ?? {},
            managedProjectIds: [
              ...serverMetadataTx?.managedProjectIds ?? [],
              project.id,
            ],
          },
        },
      });
    }

    const result = await tx.project.findUnique({
      where: { id: project.id },
      include: fullProjectInclude,
    });

    if (!result) {
      throw new StackAssertionError(`Project with id '${project.id}' not found after creation`, { project });
    }
    return result;
  });

  return projectPrismaToCrud(result);
}
