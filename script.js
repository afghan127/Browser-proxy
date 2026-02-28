document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('url-input');
    const browseBtn = document.getElementById('browse-btn');
    const loading = document.getElementById('loading');

    function handleBrowse() {
        let query = input.value.trim();
        if (!query) return;

        // Simple URL check (contains dot and no spaces)
        const isUrl = /^https?:\/\//i.test(query) || (query.includes('.') && !query.includes(' '));
        let url;
        if (isUrl) {
            if (!/^https?:\/\//i.test(query)) {
                query = 'http://' + query;
            }
            url = `/proxy?url=${encodeURIComponent(query)}`;
        } else {
            // Search via Google
            url = `/proxy?url=${encodeURIComponent('https://www.google.com/search?q=' + encodeURIComponent(query))}`;
        }

        // Show loading
        loading.classList.remove('hidden');
        // Redirect after a tiny delay to show animation
        setTimeout(() => {
            window.location.href = url;
        }, 100);
    }

    browseBtn.addEventListener('click', handleBrowse);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleBrowse();
    });
});
