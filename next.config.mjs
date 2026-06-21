/** @type {import('next').NextConfig} */
const nextConfig = {
  // postgres is an optional dependency; don't fail the build if it's absent.
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
