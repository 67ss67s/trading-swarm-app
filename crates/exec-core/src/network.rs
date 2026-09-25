//! 代理归一化、HTTP 客户端、WS 隧道。
//!
//! 来源:8794 `console-api/src/network.rs`(env 归一化 + 校验 + 脱敏 + `route_for`)
//! 与 `console-api/src/market.rs::connect_ws_via_proxy`(CONNECT / SOCKS5 隧道)。
//!
//! 三条实战教训,原样带过来:
//! 1. **六个代理 env 变量大小写两套都要管** —— 不同库读取偏好不一致,漏一半会出
//!    "REST 通、WS 不通"这类隐蔽分裂。
//! 2. **回环必须在 no_proxy**(`localhost` / `127.0.0.0/8` / `::1`)—— Clash fake-IP
//!    会劫持 127.0.0.1;hyper-util 不读 macOS 系统 ExceptionsList,必须自补。
//! 3. **matcher 选中代理后一律不回退直连** —— 回退既泄漏直连流量,又让诊断假绿。
//!
//! 改写点:去掉 `parse_network_settings` 对 8794 settings.json 形状的依赖
//! (trading-swarm 的配置在别处),保留纯函数 `plan_env` / `validate_proxy_url`;
//! `route_for` 从 `axum::http::Uri` 换成 `http::Uri`(本 crate 不依赖 axum)。

use serde_json::{Value, json};

/// 程序强制的回环 bypass。
pub const BASE_NO_PROXY: &[&str] = &["localhost", "127.0.0.0/8", "::1"];

/// 代理 env 变量,大小写两套都要管。
pub const PROXY_ENV_KEYS: &[&str] =
    &["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyMode {
    /// 继承环境/系统代理,只补 no_proxy。
    Auto,
    /// 用户显式指定代理,覆盖继承的全部代理变量。
    Manual,
    /// 强制直连(删变量 + 通配 NO_PROXY 双保险)。
    Direct,
}

impl ProxyMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "auto" | "" => Ok(Self::Auto),
            "manual" => Ok(Self::Manual),
            "direct" => Ok(Self::Direct),
            other => Err(format!("proxy_mode 只能是 auto/manual/direct,当前为 {other:?}")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
            Self::Direct => "direct",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSettings {
    pub mode: ProxyMode,
    pub proxy_url: String,
    pub no_proxy: Vec<String>,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self { mode: ProxyMode::Auto, proxy_url: String::new(), no_proxy: Vec::new() }
    }
}

impl NetworkSettings {
    /// 校验:manual 必须有合法 url;任何模式下存进来的 url 都必须合法
    /// (不能存"以后切 manual 才爆炸"的值)。
    pub fn validate(&self) -> Result<(), String> {
        if !self.proxy_url.is_empty() {
            validate_proxy_url(&self.proxy_url)?;
        }
        if self.mode == ProxyMode::Manual && self.proxy_url.is_empty() {
            return Err("manual 模式必须配置 proxy_url".into());
        }
        for item in &self.no_proxy {
            validate_no_proxy_item(item)?;
        }
        Ok(())
    }
}

/// env 注入的"计划":先算(纯函数,可测),再由 main 在**单线程期**一次性执行。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EnvPlan {
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

pub fn plan_env(settings: &NetworkSettings, inherited_no_proxy: Option<&str>) -> EnvPlan {
    let mut plan = EnvPlan::default();
    match settings.mode {
        ProxyMode::Manual => {
            // manual = 用户显式意图,覆盖继承的全部代理变量;bypass 只取内置回环 +
            // 配置项,**不继承外部 NO_PROXY**(否则继承到 NO_PROXY=* 会让 manual
            // 莫名其妙变直连)。
            for key in PROXY_ENV_KEYS {
                plan.set.push(((*key).into(), settings.proxy_url.clone()));
            }
            let mut no: Vec<String> = BASE_NO_PROXY.iter().map(|s| (*s).to_string()).collect();
            merge_no_proxy(&mut no, &settings.no_proxy);
            let value = no.join(",");
            plan.set.push(("NO_PROXY".into(), value.clone()));
            plan.set.push(("no_proxy".into(), value));
        }
        ProxyMode::Direct => {
            // 删变量 + 通配 NO_PROXY 双保险:光删变量挡不住 reqwest 的 system-proxy
            // 回填 macOS 系统代理。
            for key in PROXY_ENV_KEYS {
                plan.remove.push((*key).into());
            }
            plan.set.push(("NO_PROXY".into(), "*".into()));
            plan.set.push(("no_proxy".into(), "*".into()));
        }
        ProxyMode::Auto => {
            let mut no: Vec<String> = inherited_no_proxy
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            merge_no_proxy(&mut no, &BASE_NO_PROXY.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
            merge_no_proxy(&mut no, &settings.no_proxy);
            let value = no.join(",");
            plan.set.push(("NO_PROXY".into(), value.clone()));
            plan.set.push(("no_proxy".into(), value));
        }
    }
    plan
}

fn merge_no_proxy(into: &mut Vec<String>, items: &[String]) {
    for item in items {
        if !into.iter().any(|prev| prev.eq_ignore_ascii_case(item)) {
            into.push(item.clone());
        }
    }
}

/// 执行 env 计划。
///
/// # Safety
/// 调用方必须保证此时进程**单线程**(tokio runtime 创建之前),没有别的线程在
/// 读写环境变量。
pub unsafe fn apply_env_plan(plan: &EnvPlan) {
    for key in &plan.remove {
        unsafe { std::env::remove_var(key) };
    }
    for (key, value) in &plan.set {
        unsafe { std::env::set_var(key, value) };
    }
}

/// 代理 URL 校验。scheme 白名单是 REST 与 WS 隧道能保证行为一致的共同子集;
/// 不支持 https 代理 / socks4 / PAC。
pub fn validate_proxy_url(url: &str) -> Result<(), String> {
    if url.len() > 2048 {
        return Err("proxy_url 过长(>2048)".into());
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("proxy_url 含空白或控制字符".into());
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err("proxy_url 缺少 scheme,仅支持 http://、socks5:// 或 socks5h://".into());
    };
    if !matches!(scheme, "http" | "socks5" | "socks5h") {
        return Err(format!("proxy_url 仅支持 http://、socks5:// 或 socks5h://,不支持 {scheme}://"));
    }
    let (rest, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !path.is_empty() {
        return Err("proxy_url 不允许带路径/query".into());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("proxy_url 不允许 query/fragment".into());
    }
    let host_port = match rest.rsplit_once('@') {
        Some((userinfo, hp)) => {
            let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
            if user.is_empty() {
                return Err("proxy_url 凭据格式应为 user:pass@host".into());
            }
            if user.len() > 255 || pass.len() > 255 {
                return Err("proxy_url 用户名/密码过长(>255)".into());
            }
            hp
        }
        None => rest,
    };
    let (host, port) = if let Some(inner) = host_port.strip_prefix('[') {
        let Some((ip, tail)) = inner.split_once(']') else {
            return Err("proxy_url IPv6 地址需要闭合方括号".into());
        };
        (ip.to_owned(), tail.strip_prefix(':').map(str::to_owned))
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p.to_owned())),
            None => (host_port.to_owned(), None),
        }
    };
    if host.is_empty() {
        return Err("proxy_url 缺少主机名".into());
    }
    if let Some(port) = port
        && port.parse::<u16>().map(|p| p == 0).unwrap_or(true)
    {
        return Err("proxy_url 端口无效".into());
    }
    Ok(())
}

pub fn validate_no_proxy_item(item: &str) -> Result<(), String> {
    if item == "*" {
        return Err("no_proxy 不允许 *;需要全部直连请选择 direct 模式".into());
    }
    if let Some(bare) = item.strip_prefix("*.") {
        return Err(format!("no_proxy 不支持 {item};填写 {bare} 即同时匹配子域"));
    }
    if item.contains("://") {
        return Err(format!("no_proxy 不允许带 scheme:{item}"));
    }
    if item.contains(',') || item.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("no_proxy 项含非法字符:{item}"));
    }
    Ok(())
}

/// 凭据脱敏:`user:pass@` → `***:***@`。所有对外输出必须过这层。
pub fn mask_proxy_credentials(text: &str) -> String {
    match text.split_once("://") {
        Some((scheme, rest)) if rest.contains('@') => {
            let (_, tail) = rest.rsplit_once('@').expect("checked contains '@'");
            format!("{scheme}://***:***@{tail}")
        }
        _ => text.to_owned(),
    }
}

/// 全进程共享的 HTTP 客户端。
///
/// 8794 实战动机:①部分网络到币安的 TLS 握手大量被重置,但**已建好的连接**很稳 ——
/// 每个适配器各建 Client 会丢掉连接池、每请求重新握手;②GUI/launchd 启动不继承
/// 终端 env,不开 `system-proxy` 的话打包版直连币安 100% 连不上。
pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(8))
        .pool_idle_timeout(std::time::Duration::from_secs(280))
        .pool_max_idle_per_host(4)
        .tcp_keepalive(std::time::Duration::from_secs(45))
        .user_agent(concat!("trading-swarm-execd/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
}

/// 共享实例(连接池复用是第二道防线,与是否走代理无关)。
pub fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(build_http_client)
}

/// WS 与诊断共用的代理 Matcher。惰性初始化发生在 env 注入之后,读到的就是注入后
/// 的最终 env —— 与 reqwest 的 system-proxy 同源。
pub fn ws_proxy_matcher() -> &'static hyper_util::client::proxy::matcher::Matcher {
    static MATCHER: std::sync::OnceLock<hyper_util::client::proxy::matcher::Matcher> =
        std::sync::OnceLock::new();
    MATCHER.get_or_init(hyper_util::client::proxy::matcher::Matcher::from_system)
}

/// 某个目标当前进程实际会走哪条路(诊断用,探针会打印)。
pub fn route_for(target_host: &str, target_port: u16, applied_mode: &str) -> Value {
    use hyper_util::client::proxy::matcher::Matcher;
    let target = format!("{target_host}:{target_port}");
    let Ok(probe) = format!("https://{target}/").parse::<http::Uri>() else {
        return json!({ "target": target, "kind": "unknown" });
    };
    let env_hit = Matcher::from_env().intercept(&probe);
    match ws_proxy_matcher().intercept(&probe) {
        Some(proxy) => {
            let url = mask_proxy_credentials(&proxy.uri().to_string());
            let source = if env_hit.is_some() {
                if applied_mode == "manual" { "manual" } else { "environment" }
            } else {
                "system"
            };
            json!({ "target": target, "kind": "proxy", "source": source, "proxy_url": url })
        }
        None => {
            let wildcard = std::env::var("NO_PROXY")
                .or_else(|_| std::env::var("no_proxy"))
                .map(|v| v.split(',').any(|item| item.trim() == "*"))
                .unwrap_or(false);
            let source = if applied_mode == "direct" || wildcard { "direct" } else { "no_proxy_or_none" };
            json!({ "target": target, "kind": "direct", "source": source })
        }
    }
}

pub type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
pub type WsResponse = tokio_tungstenite::tungstenite::handshake::client::Response;

/// 代理感知的 WS 连接。
///
/// tokio-tungstenite 不走 reqwest 的代理栈 —— 只修 REST 的话,打包版(无终端 env)
/// 的用户数据流仍会直连被墙、静默退化成 REST 轮询。代理发现复用
/// [`ws_proxy_matcher`],与 reqwest 的 system-proxy 完全同源。
/// 支持 http CONNECT 隧道与 socks5/socks5h(前者本机解析 DNS,后者交代理解析 ——
/// 混用会造成"REST 通、WS 不通"的隐蔽分裂)。
///
/// **红线**:matcher 选中代理后,连接/认证/形态不支持一律显式失败,**不回退直连**。
pub async fn connect_ws_via_proxy(
    url: &str,
) -> Result<(WsStream, WsResponse), tokio_tungstenite::tungstenite::Error> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    type WsError = tokio_tungstenite::tungstenite::Error;
    fn io_err(message: String) -> WsError {
        WsError::Io(std::io::Error::other(message))
    }

    let (host, port) = ws_authority(url);
    let intercept = format!("https://{host}:{port}/")
        .parse::<http::Uri>()
        .ok()
        .and_then(|probe| ws_proxy_matcher().intercept(&probe));
    let Some(proxy) = intercept else {
        return tokio_tungstenite::connect_async(url).await;
    };

    let scheme = proxy.uri().scheme_str().unwrap_or("http").to_owned();
    let proxy_host = proxy.uri().host().unwrap_or_default().to_owned();
    let proxy_port =
        proxy.uri().port_u16().unwrap_or(if scheme.starts_with("socks") { 1080 } else { 80 });
    let mut stream = tokio::net::TcpStream::connect((proxy_host.as_str(), proxy_port)).await?;

    match scheme.as_str() {
        "http" => {
            let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
            if let Some(auth) = proxy.basic_auth().and_then(|v| v.to_str().ok()) {
                request.push_str(&format!("Proxy-Authorization: {auth}\r\n"));
            }
            request.push_str("\r\n");
            stream.write_all(request.as_bytes()).await?;
            let mut response = Vec::with_capacity(256);
            let mut byte = [0u8; 1];
            while !response.ends_with(b"\r\n\r\n") {
                if response.len() > 8192 || stream.read(&mut byte).await? == 0 {
                    return Err(io_err("proxy CONNECT: 响应异常或连接被关闭".into()));
                }
                response.push(byte[0]);
            }
            let status_line = String::from_utf8_lossy(&response);
            let ok = status_line
                .lines()
                .next()
                .is_some_and(|line| line.starts_with("HTTP/1.") && line.contains(" 200"));
            if !ok {
                return Err(io_err(format!(
                    "proxy CONNECT 被拒:{}",
                    status_line.lines().next().unwrap_or_default()
                )));
            }
        }
        "socks5" | "socks5h" => {
            let (user, pass) = proxy.raw_auth().unwrap_or(("", ""));
            if user.len() > 255 || pass.len() > 255 || host.len() > 255 {
                return Err(io_err("socks5 用户名/密码/主机名超长(>255)".into()));
            }
            let has_auth = !user.is_empty();
            let greeting: &[u8] = if has_auth { &[5, 2, 0, 2] } else { &[5, 1, 0] };
            stream.write_all(greeting).await?;
            let mut reply = [0u8; 2];
            stream.read_exact(&mut reply).await?;
            match reply {
                [5, 0] => {}
                [5, 2] if has_auth => {
                    let mut auth = vec![1u8, user.len() as u8];
                    auth.extend_from_slice(user.as_bytes());
                    auth.push(pass.len() as u8);
                    auth.extend_from_slice(pass.as_bytes());
                    stream.write_all(&auth).await?;
                    let mut auth_reply = [0u8; 2];
                    stream.read_exact(&mut auth_reply).await?;
                    if auth_reply[1] != 0 {
                        return Err(io_err("socks5 认证被拒".into()));
                    }
                }
                _ => return Err(io_err(format!("socks5 协商失败:{reply:?}"))),
            }
            let mut connect = vec![5u8, 1, 0];
            if scheme == "socks5" {
                let addrs: Vec<std::net::SocketAddr> =
                    tokio::net::lookup_host((host.as_str(), port))
                        .await
                        .map_err(|e| io_err(format!("socks5 本机 DNS 解析失败:{e}")))?
                        .collect();
                let addr = addrs
                    .iter()
                    .find(|a| a.is_ipv4())
                    .or_else(|| addrs.first())
                    .copied()
                    .ok_or_else(|| io_err("socks5 本机 DNS 解析无结果".into()))?;
                match addr.ip() {
                    std::net::IpAddr::V4(ip) => {
                        connect.push(1);
                        connect.extend_from_slice(&ip.octets());
                    }
                    std::net::IpAddr::V6(ip) => {
                        connect.push(4);
                        connect.extend_from_slice(&ip.octets());
                    }
                }
            } else {
                connect.push(3);
                connect.push(host.len() as u8);
                connect.extend_from_slice(host.as_bytes());
            }
            connect.extend_from_slice(&port.to_be_bytes());
            stream.write_all(&connect).await?;
            let mut head = [0u8; 4];
            stream.read_exact(&mut head).await?;
            if head[1] != 0 {
                return Err(io_err(format!("socks5 连接被拒(rep={})", head[1])));
            }
            let addr_len = match head[3] {
                1 => 4usize,
                4 => 16,
                3 => {
                    let mut len = [0u8; 1];
                    stream.read_exact(&mut len).await?;
                    len[0] as usize
                }
                other => return Err(io_err(format!("socks5 未知地址类型 {other}"))),
            };
            let mut rest = vec![0u8; addr_len + 2];
            stream.read_exact(&mut rest).await?;
        }
        other => {
            return Err(io_err(format!(
                "不支持的代理形态 {other}://(仅支持 http/socks5/socks5h),已拒绝直连回退"
            )));
        }
    }
    tokio_tungstenite::client_async_tls(url, stream).await
}

/// `wss://host[:port]/path` → `(host, port)`;wss 默认 443、ws 默认 80。
pub fn ws_authority(url: &str) -> (String, u16) {
    let authority = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .unwrap_or(url)
        .split(['/', '?'])
        .next()
        .unwrap_or_default();
    match authority.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => {
            (h.to_owned(), p.parse().expect("checked parse above"))
        }
        _ => (authority.to_owned(), if url.starts_with("ws://") { 80 } else { 443 }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: ProxyMode, url: &str, no_proxy: &[&str]) -> NetworkSettings {
        NetworkSettings {
            mode,
            proxy_url: url.into(),
            no_proxy: no_proxy.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn proxy_url_validation() {
        assert!(validate_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy_url("socks5h://user:pass@proxy.example.com:1080").is_ok());
        assert!(validate_proxy_url("http://[::1]:7890").is_ok());
        assert!(validate_proxy_url("http://127.0.0.1").is_ok(), "端口可省");
        assert!(validate_proxy_url("https://x").is_err(), "https 代理不支持");
        assert!(validate_proxy_url("socks4://x").is_err());
        assert!(validate_proxy_url("127.0.0.1:7890").is_err(), "缺 scheme");
        assert!(validate_proxy_url("http://").is_err(), "缺 host");
        assert!(validate_proxy_url("http://x:0").is_err());
        assert!(validate_proxy_url("http://x:70000").is_err());
        assert!(validate_proxy_url("http://x/path").is_err());
        assert!(validate_proxy_url("http://x?q=1").is_err());
        assert!(validate_proxy_url("http://a b").is_err());
        assert!(validate_proxy_url("http://:pass@x").is_err(), "有密码无用户名");
    }

    #[test]
    fn no_proxy_item_rules() {
        assert!(validate_no_proxy_item("nas.local").is_ok());
        assert!(validate_no_proxy_item("192.168.0.0/16").is_ok());
        assert!(validate_no_proxy_item(".corp.example").is_ok());
        assert!(validate_no_proxy_item("*").is_err());
        assert!(validate_no_proxy_item("*.example.com").is_err());
        assert!(validate_no_proxy_item("http://x").is_err());
        assert!(validate_no_proxy_item("a,b").is_err());
    }

    #[test]
    fn settings_validation_rejects_manual_without_url() {
        assert!(settings(ProxyMode::Manual, "", &[]).validate().is_err());
        assert!(settings(ProxyMode::Manual, "http://127.0.0.1:7897", &[]).validate().is_ok());
        // auto 下存非法 url 也拒(不能存"以后切 manual 才爆炸"的值)
        assert!(settings(ProxyMode::Auto, "ftp://x", &[]).validate().is_err());
        assert_eq!(ProxyMode::parse("direct"), Ok(ProxyMode::Direct));
        assert!(ProxyMode::parse("bogus").is_err());
    }

    #[test]
    fn env_plan_manual_overrides_and_ignores_inherited_no_proxy() {
        let plan = plan_env(&settings(ProxyMode::Manual, "http://127.0.0.1:7897", &["nas.local"]), Some("*"));
        for key in PROXY_ENV_KEYS {
            assert!(plan.set.iter().any(|(k, v)| k == key && v == "http://127.0.0.1:7897"), "{key} 缺失");
        }
        let no = &plan.set.iter().find(|(k, _)| k == "NO_PROXY").expect("NO_PROXY").1;
        assert_eq!(no, "localhost,127.0.0.0/8,::1,nas.local", "不得继承外部的 *");
        assert!(plan.remove.is_empty());
    }

    #[test]
    fn env_plan_direct_removes_and_wildcards() {
        let plan = plan_env(&settings(ProxyMode::Direct, "", &[]), Some("localhost"));
        assert_eq!(plan.remove.len(), PROXY_ENV_KEYS.len());
        assert!(plan.set.iter().any(|(k, v)| k == "NO_PROXY" && v == "*"));
        assert!(plan.set.iter().any(|(k, v)| k == "no_proxy" && v == "*"));
    }

    /// Clash fake-IP 会劫持 127.0.0.1:回环 bypass 在任何模式下都必须在。
    #[test]
    fn loopback_is_always_bypassed() {
        for mode in [ProxyMode::Auto, ProxyMode::Manual] {
            let plan = plan_env(&settings(mode, "http://127.0.0.1:7897", &[]), None);
            let no = &plan.set.iter().find(|(k, _)| k == "NO_PROXY").expect("NO_PROXY").1;
            for entry in BASE_NO_PROXY {
                assert!(no.split(',').any(|item| item == *entry), "{no} 缺少 {entry}");
            }
        }
    }

    #[test]
    fn env_plan_auto_merges_inherited_and_dedupes() {
        let plan = plan_env(&settings(ProxyMode::Auto, "", &["nas.local"]), Some("corp.example,localhost"));
        let no = &plan.set.iter().find(|(k, _)| k == "NO_PROXY").expect("NO_PROXY").1;
        assert_eq!(no, "corp.example,localhost,127.0.0.0/8,::1,nas.local");
        assert!(plan.remove.is_empty());
        // auto 不碰代理变量
        assert!(!plan.set.iter().any(|(k, _)| !k.eq_ignore_ascii_case("no_proxy")));
    }

    #[test]
    fn credentials_are_masked_everywhere_they_leave_the_process() {
        assert_eq!(
            mask_proxy_credentials("socks5h://user:secret@127.0.0.1:1080"),
            "socks5h://***:***@127.0.0.1:1080"
        );
        assert_eq!(mask_proxy_credentials("http://127.0.0.1:7897"), "http://127.0.0.1:7897");
    }

    #[test]
    fn ws_authority_defaults_by_scheme() {
        assert_eq!(ws_authority("wss://fstream.binance.com/ws/key"), ("fstream.binance.com".into(), 443));
        assert_eq!(ws_authority("ws://127.0.0.1/ws"), ("127.0.0.1".into(), 80));
        assert_eq!(ws_authority("wss://example.com:9443/ws?x=1"), ("example.com".into(), 9443));
    }
}
