# PicGo 核心上传逻辑与实现参考文档

## 1. 架构概述

PicGo 项目将 GUI（渲染进程/主进程）与核心逻辑（PicGo-Core）进行了分离。如果您要实现一个兼容系统，您需要复制其 Core Logic（核心逻辑）。

- **输入 (Input)**: 一个包含文件路径或 Buffer 的图片对象数组。
- **处理 (Process)**: 转换器 (路径 -> Buffer) -> 上传器 (Buffer -> 远程 URL)。
- **输出 (Output)**: 一个图片对象数组（已填充 imgUrl 属性）。

### 通用图片对象结构

每个上传任务都会处理具有以下结构的对象：

```json
{
  "buffer": "Buffer<二进制数据>",
  "fileName": "example.png",
  "extname": ".png",
  "imgUrl": "https://remote-url.com/example.png" // (结果)
}
```

## 2. 支持的图床（上传器）实现细节

以下是该项目支持的 7 个核心图床的逻辑规范。

### 2.1. SM.MS (默认)

最简单的上传器之一。使用 multipart/form-data 表单上传。

**配置参数**:
- `token`: (String) 从 sm.ms 获取的 Secret API Token。

**核心逻辑**:

- **请求方法**: POST
- **URL**: `https://sm.ms/api/v2/upload`
- **请求头**:
  - `Content-Type: multipart/form-data`
  - `Authorization: Basic <token>` (或者根据 API 版本直接使用 token 值)
- **请求体** (FormData):
  - `smfile`: 图片的二进制数据 (Buffer)
  - `format: json`
- **响应解析**:
  ```json
  {
    "success": true,
    "data": { "url": "https://s2.loli.net/..." }
  }
  ```
- **错误处理**: 如果 `success` 为 `false`，读取 `message` 字段。

### 2.2. GitHub

使用 GitHub REST API 将文件提交到仓库。

**配置参数**:
- `repo`: (String) "username/reponame" (用户名/仓库名)
- `branch`: (String) "main" 或 "master" (分支名)
- `token`: (String) Personal Access Token (需要勾选 repo 权限)
- `path`: (String) 存储路径 (例如 "img/")
- `customUrl`: (String, 可选) CDN 加速域名 (例如 `https://cdn.jsdelivr.net/gh/user/repo`)

**核心逻辑**:

- **准备**: 将图片 Buffer 转换为 Base64 字符串
- **请求方法**: PUT
- **URL**: `https://api.github.com/repos/:repo/contents/:path/:fileName`
- **请求头**:
  - `Authorization: token <token>`
  - `User-Agent: PicGo` (GitHub API 强制要求)
- **请求体** (JSON):
  ```json
  {
    "message": "Upload :fileName by PicGo",
    "content": "base64_string_here",
    "branch": ":branch"
  }
  ```
- **结果生成**:
  - 如果设置了 `customUrl`: 将 `https://github.com` 结构替换为 CDN 格式
  - 默认: 使用 `response.data.content.download_url`

### 2.3. Imgur

使用 Imgur API v3。注意：在某些地区通常需要代理。

**配置参数**:
- `clientId`: (String) OAuth Client ID
- `proxy`: (String, 可选) HTTP 代理地址

**核心逻辑**:
- **请求方法**: POST
- **URL**: `https://api.imgur.com/3/image`
- **请求头**:
  - `Authorization: Client-ID <clientId>`
  - `Content-Type: multipart/form-data`
- **请求体** (FormData):
  - `image`: 图片二进制数据 (或 base64)
  - `type: file` (或 base64)
  - `name: :fileName`
- **响应解析**:
  ```json
  {
    "success": true,
    "data": { "link": "https://i.imgur.com/xyz.jpg" }
  }
  ```

### 2.4. 七牛云 (Qiniu)

需要在本地使用 Access Keys 生成上传 Token。

**配置参数**:
- `accessKey`: (String)
- `secretKey`: (String)
- `bucket`: (String) 存储空间名称
- `url`: (String) 绑定在存储空间的域名 (例如 `http://images.mysite.com`)
- `area`: (String) 区域 ID (例如 `z0`, `z1`, `na0`)
- `path`: (String) 文件存储路径前缀

**核心逻辑**:

- **Token 生成**:
  - 构建通用的 Policy JSON: `{"scope": "bucket", "deadline": unix_timestamp + 3600}`
  - 使用 `secretKey` 对 Policy 进行 HMAC-SHA1 签名，并进行 Safe Base64 编码
  - 拼接字符串: `accessKey : encodedSign : encodedPolicy`
- **请求方法**: POST
- **URL**: `http://upload.qiniup.com` (或特定区域的 `upload-z1.qiniup.com`)
- **请求体** (FormData):
  - `token`: 生成的 Token
  - `key: :path/:fileName` (在存储桶中的完整路径)
  - `file`: 图片二进制数据
- **结果生成**: 拼接 `<url>/<key>`

### 2.5. 腾讯云 COS (对象存储)

使用 XML API 或 JSON API，通过 HMAC 签名验证。

**配置参数**:
- `secretId`: (String)
- `secretKey`: (String)
- `bucket`: (String) 格式为 `name-appid`
- `appId`: (String)
- `area`: (String) 例如 `ap-shanghai`
- `path`: (String) 存储路径
- `customUrl`: (String, 可选) 自定义域名

**核心逻辑**:
- **签名**: 计算 Authorization 头，使用 q-sign-algorithm, q-key-time 等参数 (复杂的 HMAC-SHA1 链式加密)
- **实现建议**: 尽可能使用官方 `cos-nodejs-sdk-v5` 封装库
- **请求方法**: PUT
- **URL**: `https://<bucket>.cos.<area>.myqcloud.com/<path>/<fileName>`
- **请求体**: 图片 Buffer
- **结果**:
  - 如果存在 `customUrl`: `<customUrl>/<path>/<fileName>`
  - 默认: 使用 endpoint URL

### 2.6. 阿里云 OSS (对象存储服务)

与 S3/COS 类似。

**配置参数**:
- `accessKeyId`: (String)
- `accessKeySecret`: (String)
- `bucket`: (String)
- `area`: (String) 例如 `oss-cn-hangzhou`
- `path`: (String)
- `customUrl`: (String, 可选)

**核心逻辑**:
- **签名**: 构建规范字符串 `PUT\n\n<ContentType>\n<Date>\n/<bucket>/<objectKey>`，使用 `accessKeySecret` 进行 HMAC-SHA1 签名
- **请求方法**: PUT
- **URL**: `https://<bucket>.<area>.aliyuncs.com/<path>/<fileName>`
- **请求头**:
  - `Authorization: OSS <accessKeyId>:<Signature>`
  - `Date: GMT 格式时间字符串`
- **请求体**: 图片 Buffer
- **结果**: `<customUrl || defaultDomain>/<path>/<fileName>`

### 2.7. 又拍云 (Upyun)

支持 Basic Auth 或标准的 REST Auth。

**配置参数**:
- `operator`: (String) 操作员名称
- `password`: (String) 操作员密码
- `bucket`: (String) 服务名称
- `url`: (String) 加速域名
- `path`: (String) 存储路径
- `suffix`: (String, 可选) 图片处理后缀

**核心逻辑**:
- **认证**:
  - 生成密码的 MD5 值
  - 构建签名字符串: `POST&/<bucket>/<path>/<fileName>&<date>`
  - 使用 MD5 后的密码进行 HMAC-SHA1 签名
- **请求方法**: PUT (REST API)
- **URL**: `https://v0.api.upyun.com/<bucket>/<path>/<fileName>`
- **请求头**:
  - `Authorization: UPYUN <operator>:<signature>`
  - `Date: GMT 格式时间字符串`
- **请求体**: 图片 Buffer
- **结果**: `<url>/<path>/<fileName><suffix>`

## 3. 实现清单 (针对您的项目)

如果您正在重构此逻辑，请确保处理好 PicGo GUI 提供的以下输入：

- **config 对象**:
  - 你需要一个方法来读取配置。在 PicGo 源码中，这是通过 `db.read().get('picBed.<type>')` 处理的。
  - 示例: `ctx.getConfig('picBed.github')` 返回 `{ repo: '...', token: '...' }`。

- **output 对象**:
  - 你的函数必须返回一个对象，或者直接修改输入对象以包含 `imgUrl`。
  - **失败**: 如果上传失败，抛出一个 Error。不要返回部分完成的对象。

- **网络库 (Networking Library)**:
  - PicGo 使用 `request-promise-native` (较旧) 或 `axios` (较新)。
  - 在实现时，请确保您的 HTTP 客户端支持：
    - Buffer 上传 (不仅仅是流)
    - 代理配置 (PicGo 允许用户设置全局代理)
