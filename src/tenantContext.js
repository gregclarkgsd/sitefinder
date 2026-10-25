export const TENANT_STORAGE_KEY = 'sitefinder-tenant';

export async function loadTenantMemberships(client, userId) {
  const {data, error} = await client
    .from('tenant_members')
    .select('tenant_id,role,tenants(name,slug)')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || [])
    .map(row => ({
      tenantId: row.tenant_id,
      role: row.role,
      name: row.tenants?.name || 'Workspace',
      slug: row.tenants?.slug || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The stored choice wins while it is still one of the user's memberships;
// otherwise the first membership by name.
export function chooseTenant(memberships, storedTenantId) {
  if (!memberships?.length) return null;
  return memberships.find(item => item.tenantId === storedTenantId) || memberships[0];
}

export function canEditTenantData(membership) {
  return membership?.role === 'admin' || membership?.role === 'member';
}
