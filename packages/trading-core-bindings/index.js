const { existsSync } = require('fs')
const { join } = require('path')
const { platform, arch } = process

const localFile = join(__dirname, `trading-core-bindings.${platform}-${arch}.node`)

if (!existsSync(localFile)) {
  throw new Error(`No native binding found for ${platform}-${arch} at ${localFile}.\nRun: pnpm --filter @traderalice/trading-core-bindings build`)
}

module.exports = require(localFile)
