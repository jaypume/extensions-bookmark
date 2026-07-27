'use strict';

// Marketplace API + extension-id parsing.

const DEFAULT_ICON = 'https://raw.githubusercontent.com/jaypume/extensions-bookmark/main/media/default-bookmark-icon.png';

function parseExtensionIds(value) {
    const seen = new Set();
    const ids = [];
    const invalid = [];
    for (const raw of String(value || '').split(/[\s,;]+/)) {
        const id = raw.trim();
        if (!id) continue;
        if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i.test(id)) {
            invalid.push(id);
            continue;
        }
        const key = id.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            ids.push(id);
        }
    }
    return { ids, invalid };
}

async function fetchMarketplaceBookmark(extensionId, category) {
    // Load Axios only when Marketplace access is needed.
    const axios = require('axios');
    const response = await axios.post(
        'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
        {
            filters: [{
                criteria: [{ filterType: 7, value: extensionId }]
            }],
            flags: 914
        },
        {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json;api-version=3.0-preview.1'
            }
        }
    );
    const extension = response.data.results?.[0]?.extensions?.[0];
    if (!extension) return null;

    const version = extension.versions[0];
    const iconFile = (version.files || []).find(file => file.assetType === 'Microsoft.VisualStudio.Services.Icons.Default');
    const downloadCount = (extension.statistics || []).find(stat => stat.statisticName === 'install');
    const rating = (extension.statistics || []).find(stat => stat.statisticName === 'averagerating');
    return {
        id: extensionId,
        displayName: extension.displayName,
        icon: iconFile ? iconFile.source : DEFAULT_ICON,
        category,
        dateAdded: new Date().toLocaleString('en-US', {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric'
        }),
        downloadCount: downloadCount ? downloadCount.value.toLocaleString() : 'N/A',
        rating: rating ? rating.value.toFixed(1) : 'N/A',
        lastUpdate: new Date(version.lastUpdated).toLocaleString('en-US', {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric'
        }),
        wantedInstall: true
    };
}

module.exports = { parseExtensionIds, fetchMarketplaceBookmark, DEFAULT_ICON };
