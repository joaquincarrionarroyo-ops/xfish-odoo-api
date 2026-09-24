const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const dominiosPermitidos = [
  'https://presuya.com.ar',
  'https://www.presuya.com.ar',
  'http://localhost',
  'http://127.0.0.1'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || dominiosPermitidos.some(domain => origin.startsWith(domain))) {
            callback(null, true);
        } else {
            callback(new Error('Bloqueado por política de seguridad CORS'));
        }
    },
    allowedHeaders: ['Content-Type', 'x-odoo-password']
}));

app.use(express.json());

const { ODOO_URL, ODOO_DB, ODOO_USER } = process.env; 

// 1. ENDPOINT GENERAL: LISTA DE PRODUCTOS
app.get('/api/productos', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    if (!ODOO_API_KEY) return res.status(401).json({ error: "Acceso denegado." });

    const authPayload = { jsonrpc: "2.0", method: "call", params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result && authRes.data.result.session_id) sessionId = authRes.data.result.session_id;

    const productPayload = { 
      jsonrpc: "2.0", method: "call", 
      params: { 
        model: "product.product", method: "search_read", 
        args: [[["sale_ok", "=", true]]], 
        kwargs: { fields: ["display_name", "default_code", "lst_price", "image_256", "uom_id", "categ_id", "product_tmpl_id", "product_template_variant_value_ids", "x_studio_ico"] } 
      } 
    };

    const templatePayload = { jsonrpc: "2.0", method: "call", params: { model: "product.template", method: "search_read", args: [[]], kwargs: { fields: ["id", "name", "product_tag_ids"] } } };
    const tagPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.tag", method: "search_read", args: [[]], kwargs: { fields: ["id", "name"] } } };
    const quantPayload = { jsonrpc: "2.0", method: "call", params: { model: "stock.quant", method: "search_read", args: [[["location_id.usage", "=", "internal"]]], kwargs: { fields: ["product_id", "location_id", "quantity"] } } };
    const extIdPayload = { jsonrpc: "2.0", method: "call", params: { model: "ir.model.data", method: "search_read", args: [[["model", "=", "product.product"]]], kwargs: { fields: ["res_id", "module", "name", "complete_name"] } } };
    const variantValuesPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.template.attribute.value", method: "search_read", args: [[]], kwargs: { fields: ["id", "display_name", "attribute_id", "name"] } } };

    const [prodRes, tempRes, tagRes, quantRes, extIdRes, varValRes] = await Promise.all([
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, productPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, templatePayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, tagPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, quantPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, extIdPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, variantValuesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const productos = prodRes.data.result || [];
    const templates = tempRes.data.result || [];
    const tagsRaw = tagRes.data.result || [];
    const quants = quantRes.data.result || [];
    const extIds = extIdRes.data.result || [];
    const varValuesRaw = varValRes.data.result || [];

    const tagsMap = {}; tagsRaw.forEach(t => { tagsMap[t.id] = t.name; });
    const templateTagsMap = {}; const templateNamesMap = {};
    templates.forEach(t => {
        templateNamesMap[t.id] = t.name;
        if (t.product_tag_ids && Array.isArray(t.product_tag_ids)) templateTagsMap[t.id] = t.product_tag_ids.map(id => tagsMap[id]).filter(Boolean).join(', ');
    });

    const attrValuesMap = {};
    varValuesRaw.forEach(v => { attrValuesMap[v.id] = { id: v.id, display_name: v.display_name, name: v.name, attribute_name: v.attribute_id ? v.attribute_id[1] : "" }; });

    const extIdMap = {};
    extIds.forEach(ext => {
        const idCompleto = ext.complete_name || (ext.module && ext.name ? `${ext.module}.${ext.name}` : null);
        if (idCompleto) extIdMap[ext.res_id] = idCompleto;
    });

    const catalogo = productos.map(p => {
        const stockProduct = quants.filter(q => q.product_id && q.product_id[0] === p.id);
        let total = 0;
        stockProduct.forEach(q => { if (q.quantity > 0) total += q.quantity; });

        let nombreCategoria = "General";
        if (p.categ_id && Array.isArray(p.categ_id)) nombreCategoria = p.categ_id[1];

        const tmplId = p.product_tmpl_id ? p.product_tmpl_id[0] : null;
        const nombreMatriz = tmplId && templateNamesMap[tmplId] ? templateNamesMap[tmplId] : p.display_name;

        return {
            id: p.id,
            tmpl_id: tmplId,
            nombre_matriz: nombreMatriz,
            id_externo: extIdMap[p.id] || `__export__.product_product_${p.id}`,
            sku: p.default_code,
            nombre: p.display_name,
            precio: p.lst_price,
            foto: p.image_256,
            ico: p.x_studio_ico || '-',
            categ_id: nombreCategoria,
            total: total
        };
    });

    res.json(catalogo);
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
});

// 2. ENDPOINT: RESUMEN DE MOVIMIENTOS GLOBALES (ENTRADAS/SALIDAS)
app.post('/api/movimientos-resumen', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const { fecha_desde, fecha_hasta } = req.body;

    if (!ODOO_API_KEY) return res.status(401).json({ error: "No autorizado" });

    const authPayload = { jsonrpc: "2.0", method: "call", params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    if (authRes.headers['set-cookie']) sessionId = authRes.headers['set-cookie'].find(c => c.startsWith('session_id=')).split(';')[0].split('=')[1];

    // Traer todos los tipos de ubicaciones para saber si son internas o externas
    const locPayload = { jsonrpc: "2.0", method: "call", params: { model: "stock.location", method: "search_read", args: [[]], kwargs: { fields: ["id", "usage"] } } };
    const locRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, locPayload, { headers: { 'Cookie': `session_id=${sessionId}` } });
    const locMap = {};
    (locRes.data.result || []).forEach(l => locMap[l.id] = l.usage);

    // Filtros de fecha
    let domain = [["state", "=", "done"]];
    if (fecha_desde) domain.push(["date", ">=", `${fecha_desde} 00:00:00`]);
    if (fecha_hasta) domain.push(["date", "<=", `${fecha_hasta} 23:59:59`]);

    const movePayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "stock.move.line", method: "search_read", 
        args: [domain],
        kwargs: { fields: ["product_id", "location_id", "location_dest_id", "qty_done"] } 
      }
    };
    const moveRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, movePayload, { headers: { 'Cookie': `session_id=${sessionId}` } });
    const movs = moveRes.data.result || [];

    const resumen = {};
    movs.forEach(m => {
        if (!m.product_id) return;
        const pid = m.product_id[0];
        if (!resumen[pid]) resumen[pid] = { entradas: 0, salidas: 0 };

        const uOrig = locMap[m.location_id[0]];
        const uDest = locMap[m.location_dest_id[0]];

        // Si viene de afuera y entra a interno = ENTRADA
        if (uOrig !== 'internal' && uDest === 'internal') resumen[pid].entradas += m.qty_done;
        // Si sale de interno hacia afuera = SALIDA
        if (uOrig === 'internal' && uDest !== 'internal') resumen[pid].salidas += m.qty_done;
    });

    res.json(resumen);
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
});

// 3. ENDPOINT: FOTO HD
app.get('/api/producto-foto-hd/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);
    if (!ODOO_API_KEY || isNaN(prodId)) return res.status(400).json({ error: "Parámetros inválidos" });

    const authPayload = { jsonrpc: "2.0", method: "call", params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    if (authRes.headers['set-cookie']) sessionId = authRes.headers['set-cookie'].find(c => c.startsWith('session_id=')).split(';')[0].split('=')[1];

    const hdPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.product", method: "read", args: [[prodId], ["image_1920"]] } };
    const hdRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, hdPayload, { headers: { 'Cookie': `session_id=${sessionId}` } });
    const result = hdRes.data.result;
    if (result && result.length > 0 && result[0].image_1920) return res.json({ foto_hd: result[0].image_1920 });

    res.status(404).json({ error: "No se encontró imagen HD" });
  } catch (error) { res.status(500).json({ error: "Error obteniendo HD" }); }
});

// 4. ENDPOINT: HISTORIAL 360 DEL PRODUCTO
app.get('/api/producto-historial/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);

    if (!ODOO_API_KEY || isNaN(prodId)) return res.status(400).json({ error: "Parámetros inválidos" });

    const authPayload = { jsonrpc: "2.0", method: "call", params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    if (authRes.headers['set-cookie']) sessionId = authRes.headers['set-cookie'].find(c => c.startsWith('session_id=')).split(';')[0].split('=')[1];

    const infoPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.product", method: "read", args: [[prodId], ["display_name", "default_code", "image_256", "lst_price", "x_studio_ico"]] } };
    const salesPayload = { jsonrpc: "2.0", method: "call", params: { model: "sale.order.line", method: "search_read", args: [[["product_id", "=", prodId], ["state", "in", ["sale", "done"]]]], kwargs: { fields: ["order_id", "product_uom_qty", "price_unit", "create_date"], order: "create_date desc" } } };
    const purchasesPayload = { jsonrpc: "2.0", method: "call", params: { model: "purchase.order.line", method: "search_read", args: [[["product_id", "=", prodId], ["state", "in", ["purchase", "done"]]]], kwargs: { fields: ["order_id", "product_qty", "price_unit", "create_date"], order: "create_date desc" } } };
    const movesPayload = { jsonrpc: "2.0", method: "call", params: { model: "stock.move.line", method: "search_read", args: [[["product_id", "=", prodId], ["state", "=", "done"]]], kwargs: { fields: ["reference", "location_id", "location_dest_id", "qty_done", "date"], order: "date desc", limit: 200 } } };

    const [infoRes, salesRes, purchRes, movesRes] = await Promise.all([
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, infoPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, salesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, purchasesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, movesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const info = infoRes.data.result && infoRes.data.result[0] ? infoRes.data.result[0] : {};

    res.json({
        producto: { id: info.id, nombre: info.display_name, sku: info.default_code, foto: info.image_256, precio_lista: info.lst_price, ico: info.x_studio_ico || '-' },
        ventas: salesRes.data.result || [], compras: purchRes.data.result || [], movimientos: movesRes.data.result || []
    });

  } catch (error) { res.status(500).json({ error: "Error interno" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
