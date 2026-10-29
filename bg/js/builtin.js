class Builtin {
    constructor() {
        this.dicts = {};
    }

    async loadData() {
        this.dicts['collins'] = await Builtin.loadData('/bg/data/collins.json');
    }

    findTerm(dictname, term) {
        const dict = this.dicts[dictname];
        return dict.hasOwnProperty(term) ? JSON.stringify(dict[term]):null;
    }

    static async loadData(path) {
        try {
            let response = await fetch(path);
            return await response.json();
        } catch (error) {
            return null;
        }
    }    
}